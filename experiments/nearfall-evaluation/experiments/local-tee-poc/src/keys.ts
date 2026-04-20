import * as openpgp from 'openpgp';

// ---------------------------------------------------------------------------
// Symmetric OpenPGP encryption (equivalent to gpg -c --armor).
// Mirrors the technique used in experiments/mn-tui/src/keys.ts so that
// mnemonics encrypted here are interchangeable with those from mn-tui.
// ---------------------------------------------------------------------------

/** Encrypt a mnemonic with a passphrase; returns an ASCII-armored PGP message. */
export async function encryptMnemonic(mnemonic: string, passphrase: string): Promise<string> {
  const message   = await openpgp.createMessage({ text: mnemonic });
  const encrypted = await openpgp.encrypt({ message, passwords: [passphrase], format: 'armored' });
  return encrypted as string;
}

/** Decrypt an ASCII-armored PGP message produced by encryptMnemonic or gpg -c --armor. */
export async function decryptMnemonic(armoredCiphertext: string, passphrase: string): Promise<string> {
  const message  = await openpgp.readMessage({ armoredMessage: armoredCiphertext });
  const { data } = await openpgp.decrypt({ message, passwords: [passphrase] });
  return data as string;
}
