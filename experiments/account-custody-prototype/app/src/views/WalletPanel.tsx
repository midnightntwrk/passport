import React, { useState } from 'react';
import { firstValueFrom } from 'rxjs';
import { rawTokenType, encodeRawTokenType } from '@midnight-ntwrk/ledger-v8';

import { randomBytes32, hexToBytes32, hexToBytes, bytesToHex } from '../../../src/wallet/hex.js';

import { getFaucet } from '../lib/midnight.js';
import { dynamicNetwork, transferWithDynamicWallet } from '../lib/dynamicTransactions.js';
import { userAddressBytes, coinPublicKeyBytes } from '../lib/providers.js';
import { ViewHeader, Panel, ActionButton, Mono, Chip } from '../ui.js';
import type { AppContext } from '../App.js';

interface PendingNote {
  nonceHex: string;
  colorHex: string;
  value: bigint;
}

const FAUCET_DOMESTIC_COLOR = hexToBytes32('06');

export function WalletPanel({ ctx }: { ctx: AppContext }) {
  const { ledger, account, mid, log, nightColor } = ctx;
  const [depositAmt, setDepositAmt] = useState('1000');
  const [withdrawAmt, setWithdrawAmt] = useState('100');
  const [mintAmt, setMintAmt] = useState('500');
  const [shieldedWithdrawAmt, setShieldedWithdrawAmt] = useState('100');
  const [faucetAddr, setFaucetAddr] = useState(mid.faucetAddress);
  const [pendingNotes, setPendingNotes] = useState<PendingNote[]>([]);

  const nights = ledger ? [...ledger.night_balances] : [];
  const coins = ledger ? [...ledger.coins] : [];

  return (
    <>
      <ViewHeader
        title="MN Passport holdings"
        narration="Assets are held by your MN Passport custody contract, not by a key. Night moves with an on-ledger balance mirror; shielded coins follow the OZ Map⟨colour, QSCI⟩ pattern — values public in this local demo."
      />

      <Panel
        title="Night — unshielded"
        sub="Custodied by the MN Passport account contract; the balance is public ledger state."
        x="Night sits in your MN Passport custody contract, not at a key-derived address. The contract keeps an on-ledger balance mirror, which is what makes balances readable from the indexer (C4)."
      >
        <table className="table-tight">
          <thead>
            <tr>
              <th>colour</th>
              <th className="num">balance</th>
            </tr>
          </thead>
          <tbody>
            {nights.length === 0 && (
              <tr>
                <td className="dim" colSpan={2}>
                  no Night held by the MN Passport custody account yet — deposit from the fee wallet below
                </td>
              </tr>
            )}
            {nights.map(([color, value]) => (
              <tr key={bytesToHex(color)}>
                <td>
                  <Mono v={bytesToHex(color)} short />
                </td>
                <td className="num num-big">{String(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row controls">
          <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} size={8} />
          <ActionButton
            label="Deposit Night"
            busyLabel="depositing…"
            task={{ label: 'Depositing Night into MN Passport custody', circuit: 'deposit_night' }}
            onRun={async () => {
              const r = await account.depositNight(nightColor, BigInt(depositAmt));
              log(`deposit_night ${depositAmt} → tx ${r.txId}`);
              await ctx.refreshLedger();
              return r.txId;
            }}
          />
          <span className="ctrl-gap" />
          <input value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} size={8} />
          <ActionButton
            label="Withdraw Night"
            busyLabel="withdrawing…"
            kind="ghost"
            task={{ label: 'Withdrawing Night to the user wallet', circuit: 'withdraw_night' }}
            onRun={async () => {
              const r = await account.withdrawNight(
                nightColor,
                BigInt(withdrawAmt),
                userAddressBytes(mid.walletCtx),
              );
              log(`withdraw_night ${withdrawAmt} → tx ${r.txId}`);
              await ctx.refreshLedger();
              return r.txId;
            }}
          />
        </div>
      </Panel>

      <DynamicTransferPanel ctx={ctx} />

      <Panel
        title="Shielded — MN Passport custody"
        sub="Coins sit in the contract keyed by colour; the QSCI keeps values public in this local demo."
        x="Shielded coins held by the contract, keyed by colour (the OZ Map⟨colour, QSCI⟩ pattern). Contract-held coin values are public ledger state — the documented C4 trade-off for this local demo."
      >
        <table>
          <thead>
            <tr>
              <th>colour</th>
              <th className="num">value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {coins.length === 0 && (
              <tr>
                <td className="dim" colSpan={3}>
                  no shielded coins held by the MN Passport custody account yet — mint from the faucet below
                </td>
              </tr>
            )}
            {coins.map(([color, qsci]) => (
              <tr key={bytesToHex(color)}>
                <td>
                  <Mono v={bytesToHex(color)} short />
                </td>
                <td className="num num-big">{String(qsci.value)}</td>
                <td className="row-actions">
                  <input
                    value={shieldedWithdrawAmt}
                    onChange={(e) => setShieldedWithdrawAmt(e.target.value)}
                    size={6}
                  />
                  <ActionButton
                    label="Withdraw"
                    busyLabel="withdrawing…"
                    kind="ghost"
                    task={{ label: 'Withdrawing shielded coins', circuit: 'withdraw_shielded' }}
                    onRun={async () => {
                      const state: any = await firstValueFrom(mid.walletCtx.wallet.state());
                      const r = await account.withdrawShielded(
                        coinPublicKeyBytes(state),
                        color,
                        BigInt(shieldedWithdrawAmt),
                      );
                      log(`withdraw_shielded ${shieldedWithdrawAmt} → tx ${r.txId}`);
                      await ctx.refreshLedger();
                      return r.txId;
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Faucet — localnet scaffolding"
        sub="Mints shielded test tokens to the fee wallet so they can be deposited; not part of production custody."
        tone="scaffold"
        x="Test scaffolding only: a faucet contract that mints shielded tokens on the localnet so the custody flows above have something to hold. Nothing like this exists in the real design."
      >
        <div className="row controls">
          <label className="field field-inline grow">
            <span className="field-label">faucet contract</span>
            <input
              value={faucetAddr}
              onChange={(e) => setFaucetAddr(e.target.value)}
              placeholder="deploy with: npm run deploy"
            />
          </label>
          <input value={mintAmt} onChange={(e) => setMintAmt(e.target.value)} size={8} />
          <ActionButton
            label="Mint shielded to wallet"
            busyLabel="minting…"
            kind="ghost"
            disabled={!faucetAddr}
            task={{ label: 'Minting shielded test tokens', circuit: 'mint_shielded' }}
            onRun={async () => {
              const faucet = await getFaucet(mid, faucetAddr.trim());
              const state: any = await firstValueFrom(mid.walletCtx.wallet.state());
              const nonce = randomBytes32();
              const r = await faucet.callTx.mint_shielded(
                FAUCET_DOMESTIC_COLOR,
                BigInt(mintAmt),
                nonce,
                { bytes: coinPublicKeyBytes(state) },
              );
              const txId = r?.public?.txId ?? r?.public?.transactionHash;
              const derived = encodeRawTokenType(
                rawTokenType(FAUCET_DOMESTIC_COLOR, faucetAddr.trim()),
              );
              setPendingNotes((p) => [
                ...p,
                {
                  nonceHex: bytesToHex(nonce),
                  colorHex: bytesToHex(derived),
                  value: BigInt(mintAmt),
                },
              ]);
              log(`faucet minted ${mintAmt} shielded → tx ${txId} (wait ~15s before depositing)`);
              return txId;
            }}
          />
        </div>
        {pendingNotes.map((note, i) => (
          <div className="note-row" key={note.nonceHex}>
            <Chip tone="warn">pending note</Chip>
            <span className="dim">
              {String(note.value)} of <Mono v={note.colorHex} short /> · nonce{' '}
              {note.nonceHex.slice(0, 10)}…
            </span>
            <span className="provedock-spacer" />
            <ActionButton
              label="Deposit into account"
              busyLabel="depositing…"
              task={{ label: 'Depositing the shielded note into MN Passport custody', circuit: 'deposit_shielded' }}
              onRun={async () => {
                const r = await account.depositShielded({
                  nonce: hexToBytes(note.nonceHex),
                  color: hexToBytes(note.colorHex),
                  value: note.value,
                });
                log(`deposit_shielded ${note.value} → tx ${r.txId}`);
                setPendingNotes((p) => p.filter((_, j) => j !== i));
                await ctx.refreshLedger();
                return r.txId;
              }}
            />
          </div>
        ))}
      </Panel>
    </>
  );
}

/**
 * Dynamic's supported value-transfer path, end to end and unmocked. This moves
 * NIGHT the embedded wallet actually holds, on the Dynamic wallet's own
 * network — it is not the localnet the custody contract lives on, and it is
 * deliberately not dressed up as a custody call.
 */
function DynamicTransferPanel({ ctx }: { ctx: AppContext }) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('1');
  const [error, setError] = useState('');
  const wallet = ctx.dynamicWallet;

  if (!wallet) return null;
  const network = dynamicNetwork(wallet);

  return (
    <Panel
      title="Dynamic embedded wallet — NIGHT transfer"
      sub={`createTransferTransaction → signTransaction → submitTransaction, on the wallet's own network (${network}).`}
      x="Dynamic can build, MPC-sign, prove, and broadcast its own transfers. It cannot yet balance a Compact contract call, which is why custody circuits are broadcast by the devnet wallet — see DYNAMIC-SIGNING.md."
    >
      <div className="row">
        <Mono v={wallet.address} short />
        <Chip tone={network === 'unknown' ? 'warn' : undefined}>{network}</Chip>
      </div>
      <div className="row controls">
        <input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="recipient unshielded address"
          size={32}
        />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} size={8} />
        <ActionButton
          label="Send NIGHT"
          busyLabel="signing and broadcasting…"
          disabled={!recipient.trim() || !/^\d+$/.test(amount.trim())}
          task={{ label: 'Transferring NIGHT from the Dynamic wallet', circuit: 'transfer' }}
          onError={setError}
          onRun={async () => {
            setError('');
            const receipt = await transferWithDynamicWallet(wallet, [
              {
                type: 'unshielded',
                recipientAddress: recipient.trim(),
                amount: amount.trim(),
              },
            ]);
            ctx.log(`Dynamic transfer ${amount.trim()} NIGHT → tx ${receipt.txHash}`);
            return receipt.txHash;
          }}
        />
      </div>
      {error && <p className="error">{error}</p>}
    </Panel>
  );
}
