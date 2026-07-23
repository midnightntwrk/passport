// Midnames + Passport localnet lifecycle:
//   owner deploys AAC -> AAC claims alias.night through Midnames ->
//   a distinct funded wallet resolves the alias and deposits a shielded token
//   through the AAC deposit_shielded circuit.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { firstValueFrom } from 'rxjs';
import { encodeRawTokenType, rawTokenType } from '@midnight-ntwrk/ledger-v8';

import {
  claimPassportAlias,
  deployMidnamesTld,
  depositShieldedByAlias,
  midnamesZkConfigPath,
  resolvePassportAlias,
} from '../integrations/midnames/preview.js';
import {
  compiledAccountContract,
  deployAccount,
  deployFaucet,
  setupWallet,
} from '../node/setup.js';
import {
  currentWalletState,
  dustBalanceOf,
  nightBalanceOf,
  registerNightForDust,
  shieldedBalanceOf,
  transferNight,
  waitForWalletState,
} from '../node/transfers.js';
import { coinPublicKeyBytes, createProviders } from '../node/wallet.js';
import { bytesToHex, randomBytes32 } from '../wallet/hex.js';
import { runScenario, step, waitForLedger } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_FILE = path.resolve(__dirname, '..', '..', 'midnames-deployment.json');

await runScenario('lifecycle-midnames', async () => {
  const owner = await setupWallet();
  const externalSeed = process.env.WALLET_SEED_SECONDARY;
  if (!externalSeed) throw new Error('WALLET_SEED_SECONDARY env var required');
  const external = await setupWallet(externalSeed);

  try {
    step('fund the external depositor and register its NIGHT for DUST');
    const ownerState = await currentWalletState(owner.walletCtx);
    console.log(`  owner NIGHT = ${nightBalanceOf(ownerState)}`);
    console.log(`  owner DUST = ${dustBalanceOf(ownerState)}`);
    const ownerDustTxId = await registerNightForDust(owner.walletCtx);
    console.log(`  ownerDustRegistrationTx = ${ownerDustTxId ?? 'already registered'}`);
    const fundingTxId = await transferNight(owner.walletCtx, external.walletCtx, 1_000_000n);
    console.log(`  fundingTx = ${fundingTxId}`);
    const dustTxId = await registerNightForDust(external.walletCtx);
    console.log(`  dustRegistrationTx = ${dustTxId ?? 'already registered'}`);

    step('deploy the Passport account-custody contract');
    const account = await deployAccount(owner, {
      deviceSecret: randomBytes32(),
      recoverySecret: randomBytes32(),
    });
    console.log(`  passport AAC @ ${account.address}`);

    step('deploy Midnames locally and claim alice.night for the AAC');
    const midnamesOwnerSecret = randomBytes32();
    const midnamesProviders = await createProviders(
      owner.walletCtx,
      midnamesZkConfigPath(),
    );
    const tld = await deployMidnamesTld(
      midnamesProviders,
      owner.walletCtx,
      midnamesOwnerSecret,
    );
    console.log(`  Midnames .night TLD @ ${tld.address}`);
    const claim = await claimPassportAlias(
      midnamesProviders,
      owner.walletCtx,
      tld,
      midnamesOwnerSecret,
      'alice',
      account.address,
    );
    console.log(`  ${claim.domain} -> ${claim.passportAddress}`);
    console.log(`  resolverDeployTx = ${claim.resolverDeployTxId}`);
    console.log(`  registerTx = ${claim.registerTxId}`);

    const resolved = await resolvePassportAlias(
      external.providers.publicDataProvider,
      tld.address,
      claim.domain,
    );
    if (resolved.address !== account.address.toLowerCase().replace(/^0200/, '')) {
      throw new Error(
        `${claim.domain} resolved to ${resolved.address}, expected ${account.address}`,
      );
    }
    console.log(`  external resolution verified: ${claim.domain} -> ${resolved.address}`);

    step('mint a shielded token to the external depositor');
    const externalState: any = await firstValueFrom(external.walletCtx.wallet.state());
    const externalCpk = coinPublicKeyBytes(externalState);
    const externalEncryptionPublicKey =
      externalState.shielded.encryptionPublicKey.toHexString();
    const domesticColor = new Uint8Array(32);
    domesticColor[31] = 6;
    const amount = 500n;
    const mintNonce = randomBytes32();
    const faucet = await deployFaucet(owner.walletCtx);
    const mintTxId = await faucet.mint(
      domesticColor,
      amount,
      mintNonce,
      externalCpk,
      externalEncryptionPublicKey,
    );
    const tokenType = rawTokenType(domesticColor, faucet.address);
    const color = encodeRawTokenType(tokenType);
    console.log(`  faucet @ ${faucet.address}`);
    console.log(`  mintTx = ${mintTxId}`);
    console.log(`  tokenType = ${String(tokenType)}`);

    await waitForWalletState(
      external.walletCtx,
      (state) => shieldedBalanceOf(state, tokenType) >= amount,
      'external depositor shielded balance',
    );

    step('resolve alice.night and deposit through the AAC shielded circuit');
    const aliasDeposit = await depositShieldedByAlias(
      external.providers,
      compiledAccountContract(),
      tld.address,
      claim.domain,
      { nonce: mintNonce, color, value: amount },
    );
    console.log(`  resolved AAC = ${aliasDeposit.resolved.address}`);
    console.log(`  depositTx = ${aliasDeposit.deposit.txId}`);

    await waitForLedger(
      account,
      `AAC holds ${amount} shielded units deposited through ${claim.domain}`,
      (ledger) => ledger.coins.member(color) && ledger.coins.lookup(color).value === amount,
      180_000,
    );

    fs.writeFileSync(
      EVIDENCE_FILE,
      `${JSON.stringify(
        {
          network: 'local',
          midnamesRevision: '83f8422b0b39113d5c14aa8adc3d42804edaf492',
          domain: claim.domain,
          tldAddress: claim.tldAddress,
          resolverAddress: claim.resolverAddress,
          passportAddress: claim.passportAddress,
          fundingTxId,
          ownerDustRegistrationTxId: ownerDustTxId,
          dustRegistrationTxId: dustTxId,
          resolverDeployTxId: claim.resolverDeployTxId,
          registrationTxId: claim.registerTxId,
          mintTxId,
          depositTxId: aliasDeposit.deposit.txId,
          tokenColor: bytesToHex(color),
          amount: amount.toString(),
          verifiedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`  evidence = ${EVIDENCE_FILE}`);
  } finally {
    await Promise.allSettled([
      owner.walletCtx.wallet.stop(),
      external.walletCtx.wallet.stop(),
    ]);
  }
});
