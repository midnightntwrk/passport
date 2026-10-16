// Vendored from sig-net/minocrab 537721ae7cd43ca7b3db09db784eb0f35ff437f4.
// MIT OR Apache-2.0; see vendor/LICENSE-MIT. Local change: normalise decoded FAB atoms.
//! The v3 transcript EXECUTOR: a circuit's public transcript produced from
//! LEDGER STATE rather than from a hand model.
//!
//! [`simulate`](minocrab_sim::v3::simulate) verifies a complete [`ProofPreimage`]: the
//! values a ledger read witnesses come from `public_transcript_outputs`,
//! which something else had to supply. Until this module existed the only
//! supplier in the workspace was a hand-written reference model (the vault
//! harness's 3.8k lines), so nothing could chain one call's post-state into
//! the next call's reads. This module closes that: given a circuit, its
//! arguments and its private transcript, it runs the circuit against a live
//! [`StateValue`] and returns the transcript the prover would have built —
//! the Impact op stream, both public halves, and the post-state.
//!
//! # What is Midnight's and what is ours
//!
//! REUSED, unchanged:
//! - [`ResultModeGather`] and [`GatherEvent`] (onchain-vm `result_mode.rs`) —
//!   Midnight's own "run this program and tell me what the state actually
//!   holds" mode. Its `process_read` takes `()` as the expected value and
//!   records the real one.
//! - [`run_program`] (onchain-vm `vm.rs`) and `QueryContext::query`
//!   (onchain-runtime `context.rs`) — the Impact VM itself, generic in the
//!   result mode. Nothing here interprets an `Op`.
//! - `Op::translate` (onchain-vm `ops.rs:405`) — Midnight's own gather →
//!   verify join, which fills a `Popeq`'s `()` with the gathered value. The
//!   upstream idiom that pairs it with a value stream is
//!   `zswap::verify::with_outputs`; that one is behind a cargo feature and
//!   filters the program first, so [`Executed::ops`] does the same zip here.
//! - [`minocrab_sim::v3::simulate_with`] — the ZKIR instruction walk, the same one
//!   [`simulate`](minocrab_sim::v3::simulate) runs, in [`Mode::Gather`].
//!
//! WRITTEN HERE, because nothing upstream has it (surveyed 2026-09-06 over
//! midnight-ledger `04c9c5d9`; notes/executor.org §2 records the search):
//! - [`decode_program`] — the INVERSE of `Op::field_repr`. Upstream encodes
//!   an op stream into field elements (that is what a circuit's
//!   `public_transcript_inputs` IS) but never decodes one, because in
//!   production the ops travel beside the proof rather than inside it. A
//!   ZKIR circuit, though, only carries the elements, so recovering the ops
//!   is the one thing that had to be written. It is the exact inverse of
//!   `minocrab-ledger`'s encoder, and `minocrab-ledger`'s own test suite
//!   round-trips every op shape that crate emits through it.
//! - [`execute`] — the fixpoint driver below.
//!
//! # Why a fixpoint
//!
//! A ledger read compiles to `public_input` gates FIRST and the op stream
//! that justifies them second (the gates are embedded in the closing
//! `popeq`), and a read's value can decide whether a later block is emitted
//! at all (an `Impact` under a guard the read produced). So there is no
//! single forward pass: the transcript the circuit asks for depends on the
//! answers, and the answers depend on the transcript.
//!
//! The loop is therefore the obvious one, and it is a fixpoint on the
//! `public_transcript_outputs` vector:
//!
//! 1. run the ZKIR walk against the guess (starting empty — a read past the
//!    end of the guess reads zeros);
//! 2. decode the accumulated `Impact` inputs into an op program;
//! 3. run that program against the live state in `ResultModeGather`;
//! 4. the gathered read values ARE the next guess.
//!
//! Each round fixes at least the first read the previous guess got wrong
//! (op emission depends only on EARLIER reads, so every op before the first
//! wrong answer is already right), which is why step 3 falls back to the
//! longest prefix that runs when the whole program does not: the reads it
//! yields are still correct, and the next round gets further. That bounds
//! the loop by the number of reads, and [`MAX_ROUNDS`] enforces it.

use std::borrow::Cow;

use midnight_base_crypto::fab::{AlignedValue, Alignment, AlignmentAtom, AlignmentSegment};
use midnight_coin_structure::contract::ContractAddress;
use midnight_onchain_runtime::context::{Effects, QueryContext};
use midnight_onchain_state::state::{ChargedState, StateValue};
use midnight_onchain_vm::cost_model::INITIAL_COST_MODEL;
use midnight_onchain_vm::ops::{Key, Op};
use midnight_onchain_vm::result_mode::{GatherEvent, ResultModeGather, ResultModeVerify};
use midnight_onchain_vm::vm::run_program;
use midnight_storage::arena::Sp;
use midnight_storage::db::InMemoryDB;
use midnight_storage::storage::{Array, HashMap as StorageHashMap};
use midnight_transient_crypto::curve::Fr;
use midnight_transient_crypto::fab::{AlignmentExt, ValueReprAlignedValue};
use midnight_transient_crypto::hash::transient_commit;
/// The Impact VM's merkle tree.
use midnight_transient_crypto::merkle_tree::MerkleTree as VmMerkleTree;
use midnight_transient_crypto::proofs::{KeyLocation, ProofPreimage};
use midnight_transient_crypto::repr::FieldRepr;
use reference_zkir::IrSource;

use crate::simulator::{Mode, Run3, Sim3Error, simulate_with};

/// The Impact op type a transcript is made of.
pub type VmOp = Op<ResultModeVerify, InMemoryDB>;
/// The same program with its read results still to be filled in.
pub type GatherOp = Op<ResultModeGather, InMemoryDB>;

/// How many rounds the fixpoint gets before it is called divergent. One
/// round per read is the bound the argument in the module docs gives; the
/// vault's widest circuit reads twenty-odd fields, and every circuit in the
/// workspace converges in two or three.
pub const MAX_ROUNDS: usize = 64;

// --- errors -----------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    /// The ZKIR walk failed for a reason unrelated to the transcript.
    #[error("circuit: {0}")]
    Circuit(#[from] Sim3Error),
    /// The circuit REJECTS this state: an `Assert` failed on the converged
    /// run. This is the executor's twin of a hand model refusing a case.
    #[error("circuit rejected the state: assertion failed at instruction {at}")]
    Rejected { at: usize },
    /// The accumulated `Impact` inputs are not a well-formed op stream.
    #[error("transcript element {at}: {message}")]
    Decode { at: usize, message: String },
    /// The Impact VM refused the program even as its longest prefix.
    #[error("impact vm: {0}")]
    Vm(String),
    /// The transcript SETTLED — every read answered, every assert passed —
    /// but the ledger will not apply it (a counter already at its maximum,
    /// say). The circuit is satisfied; the state is not.
    #[error("the ledger refuses the settled transcript: {why}")]
    NotApplied { why: String },
    /// A read's declared FAB alignment is not the one the state holds — the
    /// circuit reads the field at a different type.
    #[error("read {index}: circuit expects alignment {expected:?}, state holds {actual:?}")]
    ReadAlignment {
        index: usize,
        expected: Alignment,
        actual: Alignment,
    },
    /// The fixpoint did not settle inside [`MAX_ROUNDS`].
    #[error("the transcript did not settle in {MAX_ROUNDS} rounds")]
    Diverged,
}

fn decode_err(at: usize, message: impl Into<String>) -> ExecError {
    ExecError::Decode {
        at,
        message: message.into(),
    }
}

// --- the call's own half ----------------------------------------------------

/// Everything a call brings that state cannot supply: its arguments, its
/// witnesses, and the binding scalars. The public transcript is exactly
/// what [`execute`] derives, so it is not here.
#[derive(Debug, Clone)]
pub struct Call<'a> {
    /// The circuit's encoded argument list (`ProofPreimage::inputs`).
    pub inputs: &'a [Fr],
    /// The witnesses, in order (`ProofPreimage::private_transcript`).
    pub private_transcript: &'a [Fr],
    /// The preimage's binding input.
    pub binding_input: Fr,
    /// Randomness for the communications commitment. Required when the
    /// circuit declares one; the commitment itself spans the circuit's
    /// OUTPUTS, so only the executor can compute it.
    pub comm_rand: Option<Fr>,
    /// The proving-key name to stamp on the produced preimage.
    pub key_location: KeyLocation,
}

impl<'a> Call<'a> {
    /// A call with a zero binding input and no communications randomness.
    pub fn new(inputs: &'a [Fr], private_transcript: &'a [Fr]) -> Call<'a> {
        Call {
            inputs,
            private_transcript,
            binding_input: Fr::from(0u64),
            comm_rand: None,
            key_location: KeyLocation(Cow::Borrowed("minocrab-executor")),
        }
    }

    /// The communications-commitment randomness this call commits with.
    pub fn with_comm_rand(mut self, rand: Fr) -> Call<'a> {
        self.comm_rand = Some(rand);
        self
    }

    /// The proving-key name.
    pub fn with_key_location(mut self, key: KeyLocation) -> Call<'a> {
        self.key_location = key;
        self
    }
}

/// What one executed call produced.
#[derive(Debug)]
pub struct Executed {
    /// The complete preimage, ready for `IrSource::check` or a prover.
    pub preimage: ProofPreimage,
    /// The transcript's op stream, read results filled in from state — the
    /// same `Vec<Op<ResultModeVerify, _>>` a hand model writes by hand.
    pub ops: Vec<VmOp>,
    /// Each read's value, in read order.
    pub reads: Vec<AlignedValue>,
    /// The state after the call.
    pub post: StateValue<InMemoryDB>,
    /// The call's ledger effects.
    pub effects: Effects<InMemoryDB>,
    /// The final ZKIR run (memory, pis, outputs, op counts).
    pub run: Run3,
    /// How many rounds the fixpoint took.
    pub rounds: usize,
}

// --- the driver -------------------------------------------------------------

/// Run `ir` against the live state `ctx` holds, producing the transcript the
/// prover would build.
///
/// The state half of the answer (`post`, `effects`) comes from re-running
/// the finished transcript in `ResultModeVerify` — the same call
/// `QueryContext::run_transcript` makes on chain, so a transcript this
/// function returns is one the ledger would accept.
pub fn execute(
    ir: &IrSource,
    call: &Call<'_>,
    ctx: &QueryContext<InMemoryDB>,
) -> Result<Executed, ExecError> {
    let mut guess: Vec<Fr> = Vec::new();
    for round in 1..=MAX_ROUNDS {
        let probe = ProofPreimage {
            public_transcript_inputs: Vec::new(),
            public_transcript_outputs: guess.clone(),
            inputs: call.inputs.to_vec(),
            private_transcript: call.private_transcript.to_vec(),
            binding_input: call.binding_input,
            communications_commitment: None,
            key_location: call.key_location.clone(),
        };
        let run = simulate_with(ir, &probe, Mode::Gather)?;
        let decoded = decode_prefix(&run.public_transcript_inputs);
        let (reads, whole_err) = gather(ctx, &decoded.ops)?;
        let next = outputs_of(&reads);
        let settled = next == guess;

        // A round that could not decode the whole transcript, or could not
        // run the whole program, has not answered every read; only a round
        // that did both AND changed nothing is a fixpoint. A round that
        // changes nothing while still incomplete is stuck, and the reason
        // it stopped short is the honest error to report.
        if !settled {
            guess = next;
            continue;
        }
        // A rejection is an ANSWER, and it is the first thing to report:
        // the walk failures and the short transcript below are consequences
        // of it, not independent problems.
        if let Some(&at) = run.assert_failures.first() {
            return Err(ExecError::Rejected { at });
        }
        if let Some((at, message)) = run.walk_failures.first() {
            return Err(ExecError::Circuit(Sim3Error::Failed {
                at: *at,
                op: "gather",
                message: message.clone(),
            }));
        }
        if let Some(e) = decoded.error {
            return Err(e);
        }
        let (program, alignments) = (decoded.ops, decoded.alignments);

        // Settled. Every read the circuit declared must have been answered,
        // and at the shape the circuit declared. (A transcript the LEDGER
        // will not apply — a counter already at its maximum — still settles
        // here: the circuit is satisfied and its transcript is the right
        // one; `finish` is where the ledger gets to refuse it.)
        if reads.len() != alignments.len() {
            // The VM stopped part-way, so the reads after that point have
            // no answer: the transcript this state would justify does not
            // exist. That is the ledger refusing the call, not a bug.
            return Err(match whole_err {
                Some(why) => ExecError::NotApplied { why },
                None => ExecError::Vm(format!(
                    "the program has {} reads but the state answered {}",
                    alignments.len(),
                    reads.len()
                )),
            });
        }
        for (index, (expected, got)) in alignments.iter().zip(reads.iter()).enumerate() {
            if expected != &got.alignment {
                return Err(ExecError::ReadAlignment {
                    index,
                    expected: expected.clone(),
                    actual: got.alignment.clone(),
                });
            }
        }
        let ops = with_reads(program, &reads);
        return finish(ir, call, ctx, run, ops, reads, round);
    }
    Err(ExecError::Diverged)
}

/// Apply the finished transcript and assemble the preimage.
fn finish(
    ir: &IrSource,
    call: &Call<'_>,
    ctx: &QueryContext<InMemoryDB>,
    run: Run3,
    ops: Vec<VmOp>,
    reads: Vec<AlignedValue>,
    rounds: usize,
) -> Result<Executed, ExecError> {
    let applied = ctx
        .query::<ResultModeVerify>(&ops, None, &INITIAL_COST_MODEL)
        .map_err(|e| ExecError::NotApplied {
            why: format!("{e:?}"),
        })?;

    let mut preimage = ProofPreimage {
        public_transcript_inputs: transcript_of(&ops),
        public_transcript_outputs: outputs_of(&reads),
        inputs: call.inputs.to_vec(),
        private_transcript: call.private_transcript.to_vec(),
        binding_input: call.binding_input,
        communications_commitment: None,
        key_location: call.key_location.clone(),
    };
    if ir.do_communications_commitment {
        let rand = call.comm_rand.ok_or_else(|| {
            ExecError::Vm(
                "the circuit declares a communications commitment but the call carries no \
                 randomness for it"
                    .into(),
            )
        })?;
        preimage.communications_commitment = Some((comm_commitment(&preimage, &run, rand)?, rand));
    }
    Ok(Executed {
        preimage,
        ops,
        reads,
        post: applied.context.state.get_ref().clone(),
        effects: applied.context.effects,
        run,
        rounds,
    })
}

/// `transient_commit` over the raw inputs then the encoded outputs — the
/// same list `simulate` checks a supplied commitment against (ir_vm.rs:662).
fn comm_commitment(preimage: &ProofPreimage, run: &Run3, rand: Fr) -> Result<Fr, ExecError> {
    let mut list: Vec<Fr> = preimage.inputs.clone();
    for value in run.outputs.iter() {
        for ir_val in reference_zkir::ir_instructions::encode::encode_offcircuit(value) {
            list.push(
                ir_val
                    .try_into()
                    .map_err(|e| ExecError::Vm(format!("output is not a native value: {e}")))?,
            );
        }
    }
    Ok(transient_commit(&list[..], rand))
}

/// The read results of a gather run, as the preimage's
/// `public_transcript_outputs` — each value's limbs, no alignment.
pub fn outputs_of(reads: &[AlignedValue]) -> Vec<Fr> {
    let mut out = Vec::new();
    for av in reads {
        ValueReprAlignedValue(av.clone()).field_repr(&mut out);
    }
    out
}

/// `field_repr` of an op stream — the preimage's `public_transcript_inputs`.
pub fn transcript_of(ops: &[VmOp]) -> Vec<Fr> {
    let mut out = Vec::new();
    for op in ops {
        op.field_repr(&mut out);
    }
    out
}

/// Midnight's gather → verify join: `Op::translate` with the gathered value
/// per `Popeq`, in order (the shape of `zswap::verify::with_outputs`).
fn with_reads(program: Vec<GatherOp>, reads: &[AlignedValue]) -> Vec<VmOp> {
    let mut values = reads.iter().cloned();
    program
        .into_iter()
        .map(|op| {
            op.translate(|()| {
                values
                    .next()
                    .expect("a gathered value per popeq: checked by the caller")
            })
        })
        .collect()
}

/// Run `program` against `ctx`'s state in `ResultModeGather`, returning each
/// read's real value.
///
/// When the whole program is refused — a provisional guess can ask for a key
/// that is not there — the LONGEST PREFIX that runs is used instead. Failure
/// is monotone in the prefix length, so that prefix is a binary search, and
/// the reads it yields are the ones the next round needs (see the module
/// docs). A program whose very first op is refused yields nothing, which is
/// a divergence rather than an error only if the guess is still moving.
fn gather(
    ctx: &QueryContext<InMemoryDB>,
    program: &[GatherOp],
) -> Result<(Vec<AlignedValue>, Option<String>), ExecError> {
    let stack = ctx.to_vm_stack();
    let attempt = |n: usize| {
        run_program::<ResultModeGather, InMemoryDB>(
            &stack,
            &program[..n],
            None,
            &INITIAL_COST_MODEL,
        )
        .map(|res| res.events)
        .map_err(|e| format!("{e:?}"))
    };
    let mut whole_err = None;
    let events = match attempt(program.len()) {
        Ok(events) => events,
        Err(e) => {
            whole_err = Some(e);
            // The largest `n` that runs. `lo` always runs (the empty
            // program does), `hi` never does.
            let (mut lo, mut hi) = (0usize, program.len());
            while hi - lo > 1 {
                let mid = lo + (hi - lo) / 2;
                if attempt(mid).is_ok() {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            attempt(lo).map_err(ExecError::Vm)?
        }
    };
    Ok((
        events
            .into_iter()
            .filter_map(|e| match e {
                GatherEvent::Read(av) => Some(av),
                GatherEvent::Log(_) => None,
            })
            .collect(),
        whole_err,
    ))
}

// --- a QueryContext from a bare state ---------------------------------------

/// The context a call runs in: a state tree and the contract's own address.
pub fn context(state: StateValue<InMemoryDB>, address: [u8; 32]) -> QueryContext<InMemoryDB> {
    QueryContext::new(
        ChargedState::new(state),
        ContractAddress(midnight_base_crypto::hash::HashOutput(address)),
    )
}

// --- the decoder: field elements back into ops ------------------------------

/// Decode a circuit's accumulated `Impact` inputs into the Impact program
/// they encode, plus the FAB alignment each `popeq` declares.
///
/// The exact inverse of `Op::field_repr` (onchain-vm `ops.rs:461`), which is
/// what `minocrab-ledger`'s `ImpactOp` builders emit. Read results are left
/// as `()`: their limbs in the element stream are the circuit's own
/// `public_input` wires, whose values are what a gather pass is FOR. The
/// alignment header in front of them is constant, so the width to skip and
/// the shape to check are both known here.
pub fn decode_program(elems: &[Fr]) -> Result<(Vec<GatherOp>, Vec<Alignment>), ExecError> {
    let decoded = decode_prefix(elems);
    match decoded.error {
        Some(e) => Err(e),
        None => Ok((decoded.ops, decoded.alignments)),
    }
}

/// What [`decode_prefix`] recovered.
pub struct Decoded {
    /// The ops decoded before the stream stopped making sense.
    pub ops: Vec<GatherOp>,
    /// The FAB alignment each decoded `popeq` declares.
    pub alignments: Vec<Alignment>,
    /// Why decoding stopped short, if it did.
    pub error: Option<ExecError>,
}

/// [`decode_program`], keeping the PREFIX that decodes when the rest does
/// not.
///
/// A provisional round of the fixpoint runs the circuit against read values
/// that are still wrong, and a wrong value reaches the op stream — a map key
/// pushed from a read, say — so the elements after it need not be a
/// well-formed op at all. The prefix is still correct, because op emission
/// depends only on EARLIER reads; gathering it is what lets the next round
/// get further. [`execute`] only surfaces the error if the guess has stopped
/// moving.
pub fn decode_prefix(elems: &[Fr]) -> Decoded {
    let mut d = Decoder { elems, at: 0 };
    let mut ops = Vec::new();
    let mut alignments = Vec::new();
    let error = loop {
        if d.at >= d.elems.len() {
            break None;
        }
        match decode_one(&mut d, &mut alignments) {
            Ok(op) => ops.push(op),
            Err(e) => break Some(e),
        }
    };
    Decoded {
        ops,
        alignments,
        error,
    }
}

/// One op, advancing `d`. `alignments` collects each `popeq`'s declared
/// shape, in order.
fn decode_one(d: &mut Decoder<'_>, alignments: &mut Vec<Alignment>) -> Result<GatherOp, ExecError> {
    let at = d.at;
    let opcode = d.byte()?;
    Ok(match opcode {
        // A run of zeros is one `Noop`: the encoder writes `n` of them
        // and `assert_normalized` forbids two adjacent `Noop`s.
        0x00 => {
            let mut n = 1u32;
            while d.peek_is_zero() && n < u32::from(u8::MAX) {
                d.at += 1;
                n += 1;
            }
            Op::Noop { n }
        }
        0x01 => Op::Lt,
        0x02 => Op::Eq,
        0x03 => Op::Type,
        0x04 => Op::Size,
        0x05 => Op::New,
        0x06 => Op::And,
        0x07 => Op::Or,
        0x08 => Op::Neg,
        0x09 => Op::Log,
        0x0a => Op::Root,
        0x0b => Op::Pop,
        0x0c | 0x0d => {
            let alignment = d.alignment()?;
            d.skip(alignment.field_len())?;
            alignments.push(alignment);
            Op::Popeq {
                cached: opcode == 0x0d,
                result: (),
            }
        }
        0x0e => Op::Addi {
            immediate: d.u32()?,
        },
        0x0f => Op::Subi {
            immediate: d.u32()?,
        },
        0x10 | 0x11 => Op::Push {
            storage: opcode == 0x11,
            value: d.state_value()?,
        },
        0x12 => Op::Branch { skip: d.u32()? },
        0x13 => Op::Jmp { skip: d.u32()? },
        0x14 => Op::Add,
        0x15 => Op::Sub,
        0x16 => Op::Concat {
            cached: false,
            n: d.u32()?,
        },
        0x17 => Op::Concat {
            cached: true,
            n: d.u32()?,
        },
        0x18 => Op::Member,
        0x19 => Op::Rem { cached: false },
        0x1a => Op::Rem { cached: true },
        0x30..=0x3f => Op::Dup { n: opcode & 0x0f },
        0x40..=0x4f => Op::Swap { n: opcode & 0x0f },
        0x50..=0x8f => {
            let len = usize::from(opcode & 0x0f) + 1;
            let mut path = Vec::with_capacity(len);
            for _ in 0..len {
                path.push(d.key()?);
            }
            Op::Idx {
                cached: matches!(opcode & 0xf0, 0x60 | 0x80),
                push_path: matches!(opcode & 0xf0, 0x70 | 0x80),
                path: path.into(),
            }
        }
        0x90..=0x9f => Op::Ins {
            cached: false,
            n: opcode & 0x0f,
        },
        0xa0..=0xaf => Op::Ins {
            cached: true,
            n: opcode & 0x0f,
        },
        0xff => Op::Ckpt,
        other => return Err(decode_err(at, format!("unknown opcode {other:#04x}"))),
    })
}

struct Decoder<'a> {
    elems: &'a [Fr],
    at: usize,
}

impl Decoder<'_> {
    fn next(&mut self) -> Result<Fr, ExecError> {
        let x = *self
            .elems
            .get(self.at)
            .ok_or_else(|| decode_err(self.at, "the transcript ends mid-op"))?;
        self.at += 1;
        Ok(x)
    }

    fn peek_is_zero(&self) -> bool {
        self.elems.get(self.at) == Some(&Fr::from(0u64))
    }

    fn skip(&mut self, n: usize) -> Result<(), ExecError> {
        if self.at + n > self.elems.len() {
            return Err(decode_err(self.at, "the transcript ends mid-value"));
        }
        self.at += n;
        Ok(())
    }

    /// A small non-negative integer element.
    fn int(&mut self, limit: u128, what: &str) -> Result<u128, ExecError> {
        let at = self.at;
        let x = self.next()?;
        let le = x.as_le_bytes();
        if le.iter().skip(16).any(|b| *b != 0) {
            return Err(decode_err(at, format!("{what} is not a small integer")));
        }
        let mut buf = [0u8; 16];
        let n = le.len().min(16);
        buf[..n].copy_from_slice(&le[..n]);
        let v = u128::from_le_bytes(buf);
        if v > limit {
            return Err(decode_err(at, format!("{what} {v} is out of range")));
        }
        Ok(v)
    }

    fn byte(&mut self) -> Result<u8, ExecError> {
        Ok(self.int(0xff, "an opcode")? as u8)
    }

    fn u32(&mut self) -> Result<u32, ExecError> {
        Ok(self.int(u128::from(u32::MAX), "an operand")? as u32)
    }

    /// One `AlignmentAtom`: a `bytes<n>` length, or `-1` / `-2` for the two
    /// field atoms (transient-crypto `fab.rs:596`).
    fn atom(&mut self) -> Result<AlignmentAtom, ExecError> {
        let at = self.at;
        let x = self.next()?;
        if x == -Fr::from(1u64) {
            return Ok(AlignmentAtom::Compress);
        }
        if x == -Fr::from(2u64) {
            return Ok(AlignmentAtom::Field);
        }
        let le = x.as_le_bytes();
        if le.iter().skip(4).any(|b| *b != 0) {
            return Err(decode_err(at, "not an alignment atom"));
        }
        let mut buf = [0u8; 4];
        let n = le.len().min(4);
        buf[..n].copy_from_slice(&le[..n]);
        Ok(AlignmentAtom::Bytes {
            length: u32::from_le_bytes(buf),
        })
    }

    /// An `Alignment` header: the segment count, then one element per
    /// segment (transient-crypto `fab.rs:364`). Only atom segments are
    /// encodable this way, which is all `minocrab-ledger` emits.
    fn alignment(&mut self) -> Result<Alignment, ExecError> {
        let count = self.int(1 << 20, "an alignment length")? as usize;
        let mut segments = Vec::with_capacity(count);
        for _ in 0..count {
            segments.push(AlignmentSegment::Atom(self.atom()?));
        }
        Ok(Alignment(segments))
    }

    /// An `AlignedValue`: its alignment header, then its limbs.
    fn aligned_value(&mut self) -> Result<AlignedValue, ExecError> {
        let at = self.at;
        let alignment = self.alignment()?;
        let width = alignment.field_len();
        if self.at + width > self.elems.len() {
            return Err(decode_err(self.at, "the transcript ends mid-value"));
        }
        let limbs = &self.elems[self.at..self.at + width];
        self.at += width;
        alignment
            .parse_field_repr(limbs)
            .map(|mut value| {
                value.value.0 = value
                    .value
                    .0
                    .into_iter()
                    .map(|atom| atom.normalize())
                    .collect();
                value
            })
            .ok_or_else(|| decode_err(at, "the limbs do not fit the alignment"))
    }

    /// A path entry: `-1` is the stack, anything else an `AlignedValue`
    /// (onchain-vm `ops.rs:67`).
    fn key(&mut self) -> Result<Key, ExecError> {
        if self.elems.get(self.at) == Some(&-Fr::from(1u64)) {
            self.at += 1;
            return Ok(Key::Stack);
        }
        Ok(Key::Value(self.aligned_value()?))
    }

    /// A `StateValue` (onchain-state `state.rs:171`).
    fn state_value(&mut self) -> Result<StateValue<InMemoryDB>, ExecError> {
        let at = self.at;
        let tag = self.int(1 << 40, "a state-value tag")?;
        match tag & 0xf {
            0 => Ok(StateValue::Null),
            1 => Ok(StateValue::Cell(Sp::new(self.aligned_value()?))),
            2 => {
                let mut map: StorageHashMap<AlignedValue, StateValue<InMemoryDB>, InMemoryDB> =
                    StorageHashMap::new();
                for _ in 0..(tag >> 4) {
                    let k = self.aligned_value()?;
                    let v = self.state_value()?;
                    map = map.insert(k, v);
                }
                Ok(StateValue::Map(map))
            }
            3 => {
                let mut elems = Vec::new();
                for _ in 0..(tag >> 4) {
                    elems.push(self.state_value()?);
                }
                Ok(StateValue::Array(Array::from(elems)))
            }
            4 => {
                let height = ((tag >> 4) & 0xff) as u8;
                let entries = tag >> 12;
                if entries != 0 {
                    return Err(decode_err(
                        at,
                        "a pushed merkle tree with entries: only the blank tree is decodable",
                    ));
                }
                Ok(StateValue::BoundedMerkleTree(VmMerkleTree::blank(height)))
            }
            other => Err(decode_err(at, format!("unknown state-value tag {other}"))),
        }
    }
}

#[cfg(test)]
mod regression_tests {
    use super::*;

    #[test]
    fn unused_union_arm_decodes_as_ledger_unit() {
        // A bytes<32> zero is how Compact encodes the unused recipient arm.
        // The ledger accepts it as unit only in canonical (empty atom) form.
        let fields = [1u64, 32, 0, 0].map(Fr::from);
        let decoded = Decoder {
            elems: &fields,
            at: 0,
        }
        .aligned_value()
        .unwrap();
        <()>::try_from(&decoded.value.0[0]).unwrap();
        assert_eq!(ValueReprAlignedValue(decoded).field_vec(), fields[2..]);
    }

    #[test]
    fn normalisation_preserves_nonzero_value_and_alignment() {
        let fields = [1u64, 8, 7].map(Fr::from);
        let decoded = Decoder {
            elems: &fields,
            at: 0,
        }
        .aligned_value()
        .unwrap();
        assert_eq!(decoded.value.0[0].0, vec![7]);
        assert_eq!(
            decoded.alignment,
            Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
                length: 8
            })])
        );
        assert_eq!(ValueReprAlignedValue(decoded).field_vec(), fields[2..]);
    }
}
