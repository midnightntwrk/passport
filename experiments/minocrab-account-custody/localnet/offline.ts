import { NativeContract, rt, executions } from './adapter.js';
import { K256Device, JubjubDevice, authArgs } from '../../../contract/src/wallet/signer.js';
import { softwarePasskey } from '../../../contract/src/tests/p256-fixtures.js';
import { pureCircuits } from '../../../contract/src/wallet/contract.js';
const b = (n: number) => new Uint8Array(32).fill(n);
for (const owner of [K256Device.generate(), JubjubDevice.generate(), softwarePasskey().device]) {
    const salt = b(1), address = b(2), addressHex = Buffer.from(address).toString('hex'), coinPk = { bytes: b(3) };
    const c = new NativeContract({ held_coin: () => { throw new Error('unexpected witness'); } });
    const init = await c.initialState(rt.createConstructorContext({}, coinPk), owner.bootCommitment(salt), b(4), JubjubDevice.generate().pk, new Uint8Array(64), 60n);
    let current = init.currentContractState;
    const call = async (name: string, args: any[]) => {
        const ctx = rt.createCircuitContext({ circuitId: name, contractAddress: addressHex, coinPublicKeyOrZswapState: coinPk, contractState: current, privateState: {}, time: 1800000000 });
        const result = await (c.provableCircuits as any)[name](ctx, ...args);
        current = result.context.callContext.currentQueryContext.state;
    };
    await call(`activate_initial_device_with_${owner.arm}`, owner.arm === 'jubjub' ? [owner.pk, salt] : owner.arm === 'k256' ? [owner.pk, salt, owner.envelope] : [owner.pk, salt, owner.policy]);
    const challenge = (pureCircuits as any)[`challenge_append_inbox_with_${owner.arm}`], entry = new Uint8Array(192).fill(9);
    const auth = owner.arm === 'jubjub' ? owner.sign((r: any, grind: any) => challenge({ bytes: address }, r, owner.pk, entry, 0n, grind), 0n) : await owner.sign(challenge({ bytes: address }, owner.pk, entry, 0n), 0n);
    await call(`append_inbox_with_${owner.arm}`, [entry, ...(owner.arm === 'p256' ? [auth] : authArgs(auth))]);
    console.log('PASS native SDK bridge', owner.arm);
}
console.log(executions);
