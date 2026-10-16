//! Initial public state, before the address-bound activation step.
use midnight_base_crypto::fab::{
    AlignedValue, Alignment, AlignmentAtom, AlignmentSegment, Value, ValueAtom,
};
use midnight_onchain_state::state::StateValue;
use midnight_storage::{
    arena::Sp,
    db::InMemoryDB,
    storage::{Array, HashMap},
};

fn cell(bytes: &[u8], width: u32) -> StateValue<InMemoryDB> {
    StateValue::Cell(Sp::new(AlignedValue {
        value: Value(vec![ValueAtom(bytes.to_vec()).normalize()]),
        alignment: Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: width,
        })]),
    }))
}

/// Mirrors the reference constructor. The caller computes the salted boot
/// commitment; a contract address cannot be known at construction time.
pub fn initial_state(
    boot: [u8; 32],
    encryption_key: [u8; 32],
    recovery_pk: AlignedValue,
    wrap: [u8; 64],
    veto_window: u64,
) -> StateValue<InMemoryDB> {
    let mut fields = vec![
        cell(&[], 8),
        cell(&encryption_key, 32),
        StateValue::Map(HashMap::new()),
        cell(&[], 8),
        StateValue::Map(HashMap::new()),
        cell(&[3], 4),
        StateValue::Map(HashMap::new()),
        cell(&[], 4),
        cell(&[], 1),
        cell(&[], 8),
        cell(&boot, 32),
        cell(&[], 1),
        StateValue::Map(HashMap::new()),
        cell(&[], 4),
        StateValue::Cell(Sp::new(recovery_pk)),
        StateValue::Map(HashMap::new()),
        cell(&[], 1),
        cell(&[], 32),
        cell(&wrap, 64),
        cell(&[1], 4),
        cell(&[], 1),
        cell(&[], 32),
        StateValue::Cell(Sp::new(AlignedValue {
            value: Value(vec![ValueAtom(vec![]), ValueAtom(vec![1])]),
            alignment: Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Field); 2]),
        })),
        cell(&[], 8),
        cell(&veto_window.to_le_bytes(), 8),
    ];
    // Compact's ledger tree has a leading remainder then groups of 15 cells.
    let tail = fields.split_off(10);
    StateValue::Array(Array::from(vec![
        StateValue::Array(Array::from(fields)),
        StateValue::Array(Array::from(tail)),
    ]))
}
