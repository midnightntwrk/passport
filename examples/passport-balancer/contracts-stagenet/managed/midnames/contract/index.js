import * as __compactRuntime from '@midnight-ntwrk/compact-runtime';
__compactRuntime.checkRuntimeVersion('0.18.0-rc.1');

export var AddressType;
(function (AddressType) {
  AddressType[AddressType['ContractAddr'] = 0] = 'ContractAddr';
  AddressType[AddressType['ZswapCPKAddr'] = 1] = 'ZswapCPKAddr';
  AddressType[AddressType['UnshieldedAddr'] = 2] = 'UnshieldedAddr';
})(AddressType || (AddressType = {}));

const _descriptor_0 = new __compactRuntime.CompactTypeBytes(32);

class _UserAddress_0 {
  alignment() {
    return _descriptor_0.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.bytes);
  }
}

const _descriptor_1 = new _UserAddress_0();

class _tuple_0 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_1.alignment());
  }
  fromValue(value_0) {
    return [
      _descriptor_0.fromValue(value_0),
      _descriptor_1.fromValue(value_0)
    ]
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0[0]).concat(_descriptor_1.toValue(value_0[1]));
  }
}

const _descriptor_2 = new _tuple_0();

const _descriptor_3 = new __compactRuntime.CompactTypeUnsignedInteger(255n, 1);

const _descriptor_4 = __compactRuntime.CompactTypeBoolean;

const _descriptor_5 = new __compactRuntime.CompactTypeUnsignedInteger(4294967295n, 4);

class _ContractAddress_0 {
  alignment() {
    return _descriptor_0.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.bytes);
  }
}

const _descriptor_6 = new _ContractAddress_0();

class _ZswapCoinPublicKey_0 {
  alignment() {
    return _descriptor_0.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.bytes);
  }
}

const _descriptor_7 = new _ZswapCoinPublicKey_0();

class _Either_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_7.alignment().concat(_descriptor_1.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_4.fromValue(value_0),
      left: _descriptor_7.fromValue(value_0),
      right: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.is_left).concat(_descriptor_7.toValue(value_0.left).concat(_descriptor_1.toValue(value_0.right)));
  }
}

const _descriptor_8 = new _Either_0();

class _Either_1 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_6.alignment().concat(_descriptor_8.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_4.fromValue(value_0),
      left: _descriptor_6.fromValue(value_0),
      right: _descriptor_8.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.is_left).concat(_descriptor_6.toValue(value_0.left).concat(_descriptor_8.toValue(value_0.right)));
  }
}

const _descriptor_9 = new _Either_1();

class _DomainData_0 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_6.alignment());
  }
  fromValue(value_0) {
    return {
      owner: _descriptor_0.fromValue(value_0),
      resolver: _descriptor_6.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.owner).concat(_descriptor_6.toValue(value_0.resolver));
  }
}

const _descriptor_10 = new _DomainData_0();

const _descriptor_11 = new __compactRuntime.CompactTypeUnsignedInteger(18446744073709551615n, 8);

const _descriptor_12 = new __compactRuntime.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);

const _descriptor_13 = __compactRuntime.CompactTypeOpaqueString;

class _Maybe_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_13.alignment());
  }
  fromValue(value_0) {
    return {
      is_some: _descriptor_4.fromValue(value_0),
      value: _descriptor_13.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.is_some).concat(_descriptor_13.toValue(value_0.value));
  }
}

const _descriptor_14 = new _Maybe_0();

class _tuple_1 {
  alignment() {
    return _descriptor_13.alignment().concat(_descriptor_13.alignment());
  }
  fromValue(value_0) {
    return [
      _descriptor_13.fromValue(value_0),
      _descriptor_13.fromValue(value_0)
    ]
  }
  toValue(value_0) {
    return _descriptor_13.toValue(value_0[0]).concat(_descriptor_13.toValue(value_0[1]));
  }
}

const _descriptor_15 = new _tuple_1();

class _Maybe_1 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_15.alignment());
  }
  fromValue(value_0) {
    return {
      is_some: _descriptor_4.fromValue(value_0),
      value: _descriptor_15.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.is_some).concat(_descriptor_15.toValue(value_0.value));
  }
}

const _descriptor_16 = new _Maybe_1();

const _descriptor_17 = new __compactRuntime.CompactTypeVector(10, _descriptor_16);

class _Either_2 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_4.fromValue(value_0),
      left: _descriptor_0.fromValue(value_0),
      right: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.is_left).concat(_descriptor_0.toValue(value_0.left).concat(_descriptor_0.toValue(value_0.right)));
  }
}

const _descriptor_18 = new _Either_2();

class _tuple_2 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_0.alignment());
  }
  fromValue(value_0) {
    return [
      _descriptor_0.fromValue(value_0),
      _descriptor_0.fromValue(value_0)
    ]
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0[0]).concat(_descriptor_0.toValue(value_0[1]));
  }
}

const _descriptor_19 = new _tuple_2();

class _Either_3 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_6.alignment().concat(_descriptor_1.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_4.fromValue(value_0),
      left: _descriptor_6.fromValue(value_0),
      right: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.is_left).concat(_descriptor_6.toValue(value_0.left).concat(_descriptor_1.toValue(value_0.right)));
  }
}

const _descriptor_20 = new _Either_3();

class _Maybe_2 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_0.alignment());
  }
  fromValue(value_0) {
    return {
      is_some: _descriptor_4.fromValue(value_0),
      value: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.is_some).concat(_descriptor_0.toValue(value_0.value));
  }
}

const _descriptor_21 = new _Maybe_2();

export class Contract {
  witnesses;
  constructor(...args_0) {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`Contract constructor: expected 1 argument, received ${args_0.length}`);
    }
    const witnesses_0 = args_0[0];
    if (typeof(witnesses_0) !== 'object') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor is not an object');
    }
    if (typeof(witnesses_0.secretKey) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named secretKey');
    }
    this.witnesses = witnesses_0;
    this.circuits = {
      update_color: async (...args_1) => {
        if (args_1.length !== 2) {
          throw new __compactRuntime.CompactError(`update_color: expected 2 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const c_0 = args_1[1];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('update_color',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 118 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(c_0.buffer instanceof ArrayBuffer && c_0.BYTES_PER_ELEMENT === 1 && c_0.length === 32)) {
          __compactRuntime.typeError('update_color',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'midnames.compact line 118 char 1',
                                     'Bytes<32>',
                                     c_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(c_0),
            alignment: _descriptor_0.alignment()
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._update_color_0(context,
                                                    partialProofData,
                                                    c_0);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      update_costs: async (...args_1) => {
        if (args_1.length !== 5) {
          throw new __compactRuntime.CompactError(`update_costs: expected 5 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const cost_short_0 = args_1[1];
        const cost_med_0 = args_1[2];
        const cost_long_0 = args_1[3];
        const enabled_0 = args_1[4];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('update_costs',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 123 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(typeof(cost_short_0) === 'bigint' && cost_short_0 >= 0n && cost_short_0 <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('update_costs',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'midnames.compact line 123 char 1',
                                     'Uint<0..340282366920938463463374607431768211456>',
                                     cost_short_0)
        }
        if (!(typeof(cost_med_0) === 'bigint' && cost_med_0 >= 0n && cost_med_0 <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('update_costs',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'midnames.compact line 123 char 1',
                                     'Uint<0..340282366920938463463374607431768211456>',
                                     cost_med_0)
        }
        if (!(typeof(cost_long_0) === 'bigint' && cost_long_0 >= 0n && cost_long_0 <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('update_costs',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'midnames.compact line 123 char 1',
                                     'Uint<0..340282366920938463463374607431768211456>',
                                     cost_long_0)
        }
        if (!(typeof(enabled_0) === 'boolean')) {
          __compactRuntime.typeError('update_costs',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'midnames.compact line 123 char 1',
                                     'Boolean',
                                     enabled_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_12.toValue(cost_short_0).concat(_descriptor_12.toValue(cost_med_0).concat(_descriptor_12.toValue(cost_long_0).concat(_descriptor_4.toValue(enabled_0)))),
            alignment: _descriptor_12.alignment().concat(_descriptor_12.alignment().concat(_descriptor_12.alignment().concat(_descriptor_4.alignment())))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._update_costs_0(context,
                                                    partialProofData,
                                                    cost_short_0,
                                                    cost_med_0,
                                                    cost_long_0,
                                                    enabled_0);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      update_default_field: async (...args_1) => {
        if (args_1.length !== 2) {
          throw new __compactRuntime.CompactError(`update_default_field: expected 2 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const d_0 = args_1[1];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('update_default_field',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 132 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(typeof(d_0) === 'object' && typeof(d_0.is_some) === 'boolean' && true)) {
          __compactRuntime.typeError('update_default_field',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'midnames.compact line 132 char 1',
                                     'struct Maybe<is_some: Boolean, value: Opaque<"string">>',
                                     d_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_14.toValue(d_0),
            alignment: _descriptor_14.alignment()
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._update_default_field_0(context,
                                                            partialProofData,
                                                            d_0);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      add_multiple_fields: async (...args_1) => {
        if (args_1.length !== 2) {
          throw new __compactRuntime.CompactError(`add_multiple_fields: expected 2 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const kvs_0 = args_1[1];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('add_multiple_fields',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 137 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(Array.isArray(kvs_0) && kvs_0.length === 10 && kvs_0.every((t) => typeof(t) === 'object' && typeof(t.is_some) === 'boolean' && Array.isArray(t.value) && t.value.length === 2  && true && true))) {
          __compactRuntime.typeError('add_multiple_fields',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'midnames.compact line 137 char 1',
                                     'Vector<10, struct Maybe<is_some: Boolean, value: [Opaque<"string">, Opaque<"string">]>>',
                                     kvs_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_17.toValue(kvs_0),
            alignment: _descriptor_17.alignment()
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._add_multiple_fields_0(context,
                                                           partialProofData,
                                                           kvs_0);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      clear_field: async (...args_1) => {
        if (args_1.length !== 2) {
          throw new __compactRuntime.CompactError(`clear_field: expected 2 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const k_0 = args_1[1];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('clear_field',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 146 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_13.toValue(k_0),
            alignment: _descriptor_13.alignment()
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._clear_field_0(context,
                                                   partialProofData,
                                                   k_0);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      clear_all_fields: async (...args_1) => {
        if (args_1.length !== 1) {
          throw new __compactRuntime.CompactError(`clear_all_fields: expected 1 argument (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('clear_all_fields',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 151 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: { value: [], alignment: [] },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._clear_all_fields_0(context,
                                                        partialProofData);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      register_domain_for: async (...args_1) => {
        if (args_1.length !== 5) {
          throw new __compactRuntime.CompactError(`register_domain_for: expected 5 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const owner_0 = args_1[1];
        const domain_0 = args_1[2];
        const len_0 = args_1[3];
        const resolver_0 = args_1[4];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('register_domain_for',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 156 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(owner_0.buffer instanceof ArrayBuffer && owner_0.BYTES_PER_ELEMENT === 1 && owner_0.length === 32)) {
          __compactRuntime.typeError('register_domain_for',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'midnames.compact line 156 char 1',
                                     'Bytes<32>',
                                     owner_0)
        }
        if (!(domain_0.buffer instanceof ArrayBuffer && domain_0.BYTES_PER_ELEMENT === 1 && domain_0.length === 32)) {
          __compactRuntime.typeError('register_domain_for',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'midnames.compact line 156 char 1',
                                     'Bytes<32>',
                                     domain_0)
        }
        if (!(typeof(len_0) === 'bigint' && len_0 >= 0n && len_0 <= 4294967295n)) {
          __compactRuntime.typeError('register_domain_for',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'midnames.compact line 156 char 1',
                                     'Uint<0..4294967296>',
                                     len_0)
        }
        if (!(typeof(resolver_0) === 'object' && resolver_0.bytes.buffer instanceof ArrayBuffer && resolver_0.bytes.BYTES_PER_ELEMENT === 1 && resolver_0.bytes.length === 32)) {
          __compactRuntime.typeError('register_domain_for',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'midnames.compact line 156 char 1',
                                     'struct ContractAddress<bytes: Bytes<32>>',
                                     resolver_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(owner_0).concat(_descriptor_0.toValue(domain_0).concat(_descriptor_5.toValue(len_0).concat(_descriptor_6.toValue(resolver_0)))),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_5.alignment().concat(_descriptor_6.alignment())))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._register_domain_for_0(context,
                                                           partialProofData,
                                                           owner_0,
                                                           domain_0,
                                                           len_0,
                                                           resolver_0);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      set_resolver: async (...args_1) => {
        if (args_1.length !== 3) {
          throw new __compactRuntime.CompactError(`set_resolver: expected 3 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const domain_0 = args_1[1];
        const resolver_0 = args_1[2];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('set_resolver',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 192 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(domain_0.buffer instanceof ArrayBuffer && domain_0.BYTES_PER_ELEMENT === 1 && domain_0.length === 32)) {
          __compactRuntime.typeError('set_resolver',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'midnames.compact line 192 char 1',
                                     'Bytes<32>',
                                     domain_0)
        }
        if (!(typeof(resolver_0) === 'object' && resolver_0.bytes.buffer instanceof ArrayBuffer && resolver_0.bytes.BYTES_PER_ELEMENT === 1 && resolver_0.bytes.length === 32)) {
          __compactRuntime.typeError('set_resolver',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'midnames.compact line 192 char 1',
                                     'struct ContractAddress<bytes: Bytes<32>>',
                                     resolver_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(domain_0).concat(_descriptor_6.toValue(resolver_0)),
            alignment: _descriptor_0.alignment().concat(_descriptor_6.alignment())
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._set_resolver_0(context,
                                                    partialProofData,
                                                    domain_0,
                                                    resolver_0);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      update_domain_target: async (...args_1) => {
        if (args_1.length !== 2) {
          throw new __compactRuntime.CompactError(`update_domain_target: expected 2 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const new_target_0 = args_1[1];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('update_domain_target',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 206 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(typeof(new_target_0) === 'object' && typeof(new_target_0.is_left) === 'boolean' && typeof(new_target_0.left) === 'object' && new_target_0.left.bytes.buffer instanceof ArrayBuffer && new_target_0.left.bytes.BYTES_PER_ELEMENT === 1 && new_target_0.left.bytes.length === 32 && typeof(new_target_0.right) === 'object' && typeof(new_target_0.right.is_left) === 'boolean' && typeof(new_target_0.right.left) === 'object' && new_target_0.right.left.bytes.buffer instanceof ArrayBuffer && new_target_0.right.left.bytes.BYTES_PER_ELEMENT === 1 && new_target_0.right.left.bytes.length === 32 && typeof(new_target_0.right.right) === 'object' && new_target_0.right.right.bytes.buffer instanceof ArrayBuffer && new_target_0.right.right.bytes.BYTES_PER_ELEMENT === 1 && new_target_0.right.right.bytes.length === 32)) {
          __compactRuntime.typeError('update_domain_target',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'midnames.compact line 206 char 1',
                                     'struct Either<is_left: Boolean, left: struct ContractAddress<bytes: Bytes<32>>, right: struct Either<is_left: Boolean, left: struct ZswapCoinPublicKey<bytes: Bytes<32>>, right: struct UserAddress<bytes: Bytes<32>>>>',
                                     new_target_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_9.toValue(new_target_0),
            alignment: _descriptor_9.alignment()
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._update_domain_target_0(context,
                                                            partialProofData,
                                                            new_target_0);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      transfer_domain: async (...args_1) => {
        if (args_1.length !== 3) {
          throw new __compactRuntime.CompactError(`transfer_domain: expected 3 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const domain_0 = args_1[1];
        const new_owner_0 = args_1[2];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('transfer_domain',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 212 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(domain_0.buffer instanceof ArrayBuffer && domain_0.BYTES_PER_ELEMENT === 1 && domain_0.length === 32)) {
          __compactRuntime.typeError('transfer_domain',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'midnames.compact line 212 char 1',
                                     'Bytes<32>',
                                     domain_0)
        }
        if (!(new_owner_0.buffer instanceof ArrayBuffer && new_owner_0.BYTES_PER_ELEMENT === 1 && new_owner_0.length === 32)) {
          __compactRuntime.typeError('transfer_domain',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'midnames.compact line 212 char 1',
                                     'Bytes<32>',
                                     new_owner_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(domain_0).concat(_descriptor_0.toValue(new_owner_0)),
            alignment: _descriptor_0.alignment().concat(_descriptor_0.alignment())
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._transfer_domain_0(context,
                                                       partialProofData,
                                                       domain_0,
                                                       new_owner_0);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      change_owner: async (...args_1) => {
        if (args_1.length !== 3) {
          throw new __compactRuntime.CompactError(`change_owner: expected 3 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const new_owner_0 = args_1[1];
        const new_address_0 = args_1[2];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('change_owner',
                                     'argument 1 (as invoked from Typescript)',
                                     'midnames.compact line 234 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(new_owner_0.buffer instanceof ArrayBuffer && new_owner_0.BYTES_PER_ELEMENT === 1 && new_owner_0.length === 32)) {
          __compactRuntime.typeError('change_owner',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'midnames.compact line 234 char 1',
                                     'Bytes<32>',
                                     new_owner_0)
        }
        if (!(typeof(new_address_0) === 'object' && new_address_0.bytes.buffer instanceof ArrayBuffer && new_address_0.bytes.BYTES_PER_ELEMENT === 1 && new_address_0.bytes.length === 32)) {
          __compactRuntime.typeError('change_owner',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'midnames.compact line 234 char 1',
                                     'struct UserAddress<bytes: Bytes<32>>',
                                     new_address_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(new_owner_0).concat(_descriptor_1.toValue(new_address_0)),
            alignment: _descriptor_0.alignment().concat(_descriptor_1.alignment())
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._change_owner_0(context,
                                                    partialProofData,
                                                    new_owner_0,
                                                    new_address_0);
        partialProofData.output = { value: [], alignment: [] };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      }
    };
    this.impureCircuits = {
      update_color: this.circuits.update_color,
      update_costs: this.circuits.update_costs,
      update_default_field: this.circuits.update_default_field,
      add_multiple_fields: this.circuits.add_multiple_fields,
      clear_field: this.circuits.clear_field,
      clear_all_fields: this.circuits.clear_all_fields,
      register_domain_for: this.circuits.register_domain_for,
      set_resolver: this.circuits.set_resolver,
      update_domain_target: this.circuits.update_domain_target,
      transfer_domain: this.circuits.transfer_domain,
      change_owner: this.circuits.change_owner
    };
    this.provableCircuits = {
      update_color: this.circuits.update_color,
      update_costs: this.circuits.update_costs,
      update_default_field: this.circuits.update_default_field,
      add_multiple_fields: this.circuits.add_multiple_fields,
      clear_field: this.circuits.clear_field,
      clear_all_fields: this.circuits.clear_all_fields,
      register_domain_for: this.circuits.register_domain_for,
      set_resolver: this.circuits.set_resolver,
      update_domain_target: this.circuits.update_domain_target,
      transfer_domain: this.circuits.transfer_domain,
      change_owner: this.circuits.change_owner
    };
  }
  async initialState(...args_0) {
    if (args_0.length !== 14) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 14 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const constructorContext_0 = args_0[0];
    const parent_domain_0 = args_0[1];
    const parent_resolver_0 = args_0[2];
    const target_0 = args_0[3];
    const domain_0 = args_0[4];
    const coin_color_0 = args_0[5];
    const cost_short_0 = args_0[6];
    const cost_med_0 = args_0[7];
    const cost_long_0 = args_0[8];
    const default_field_0 = args_0[9];
    const buy_enabled_0 = args_0[10];
    const owner_pubkey_0 = args_0[11];
    const owner_address_0 = args_0[12];
    const kvs_0 = args_0[13];
    if (typeof(constructorContext_0) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'constructorContext' in argument 1 (as invoked from Typescript) to be an object`);
    }
    if (!('initialPrivateState' in constructorContext_0)) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialPrivateState' in argument 1 (as invoked from Typescript)`);
    }
    if (!('initialZswapLocalState' in constructorContext_0)) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript)`);
    }
    if (typeof(constructorContext_0.initialZswapLocalState) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript) to be an object`);
    }
    if (!(typeof(parent_domain_0) === 'object' && typeof(parent_domain_0.is_some) === 'boolean' && parent_domain_0.value.buffer instanceof ArrayBuffer && parent_domain_0.value.BYTES_PER_ELEMENT === 1 && parent_domain_0.value.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 1 (argument 2 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'struct Maybe<is_some: Boolean, value: Bytes<32>>',
                                 parent_domain_0)
    }
    if (!(typeof(parent_resolver_0) === 'object' && parent_resolver_0.bytes.buffer instanceof ArrayBuffer && parent_resolver_0.bytes.BYTES_PER_ELEMENT === 1 && parent_resolver_0.bytes.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 2 (argument 3 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'struct ContractAddress<bytes: Bytes<32>>',
                                 parent_resolver_0)
    }
    if (!(Array.isArray(target_0) && target_0.length === 2  && target_0[0].buffer instanceof ArrayBuffer && target_0[0].BYTES_PER_ELEMENT === 1 && target_0[0].length === 32 && typeof(target_0[1]) === 'number' && target_0[1] >= 0 && target_0[1] <= 2)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 3 (argument 4 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 '[Bytes<32>, Enum<AddressType, ContractAddr, ZswapCPKAddr, UnshieldedAddr>]',
                                 target_0)
    }
    if (!(typeof(domain_0) === 'object' && typeof(domain_0.is_some) === 'boolean' && domain_0.value.buffer instanceof ArrayBuffer && domain_0.value.BYTES_PER_ELEMENT === 1 && domain_0.value.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 4 (argument 5 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'struct Maybe<is_some: Boolean, value: Bytes<32>>',
                                 domain_0)
    }
    if (!(coin_color_0.buffer instanceof ArrayBuffer && coin_color_0.BYTES_PER_ELEMENT === 1 && coin_color_0.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 5 (argument 6 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'Bytes<32>',
                                 coin_color_0)
    }
    if (!(typeof(cost_short_0) === 'bigint' && cost_short_0 >= 0n && cost_short_0 <= 340282366920938463463374607431768211455n)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 6 (argument 7 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'Uint<0..340282366920938463463374607431768211456>',
                                 cost_short_0)
    }
    if (!(typeof(cost_med_0) === 'bigint' && cost_med_0 >= 0n && cost_med_0 <= 340282366920938463463374607431768211455n)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 7 (argument 8 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'Uint<0..340282366920938463463374607431768211456>',
                                 cost_med_0)
    }
    if (!(typeof(cost_long_0) === 'bigint' && cost_long_0 >= 0n && cost_long_0 <= 340282366920938463463374607431768211455n)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 8 (argument 9 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'Uint<0..340282366920938463463374607431768211456>',
                                 cost_long_0)
    }
    if (!(typeof(default_field_0) === 'object' && typeof(default_field_0.is_some) === 'boolean' && true)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 9 (argument 10 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'struct Maybe<is_some: Boolean, value: Opaque<"string">>',
                                 default_field_0)
    }
    if (!(typeof(buy_enabled_0) === 'boolean')) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 10 (argument 11 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'Boolean',
                                 buy_enabled_0)
    }
    if (!(owner_pubkey_0.buffer instanceof ArrayBuffer && owner_pubkey_0.BYTES_PER_ELEMENT === 1 && owner_pubkey_0.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 11 (argument 12 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'Bytes<32>',
                                 owner_pubkey_0)
    }
    if (!(typeof(owner_address_0) === 'object' && owner_address_0.bytes.buffer instanceof ArrayBuffer && owner_address_0.bytes.BYTES_PER_ELEMENT === 1 && owner_address_0.bytes.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 12 (argument 13 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'struct UserAddress<bytes: Bytes<32>>',
                                 owner_address_0)
    }
    if (!(Array.isArray(kvs_0) && kvs_0.length === 10 && kvs_0.every((t) => typeof(t) === 'object' && typeof(t.is_some) === 'boolean' && Array.isArray(t.value) && t.value.length === 2  && true && true))) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 13 (argument 14 as invoked from Typescript)',
                                 'midnames.compact line 63 char 1',
                                 'Vector<10, struct Maybe<is_some: Boolean, value: [Opaque<"string">, Opaque<"string">]>>',
                                 kvs_0)
    }
    const state_0 = new __compactRuntime.ContractState();
    let stateValue_0 = __compactRuntime.StateValue.newArray();
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    state_0.data = new __compactRuntime.ChargedState(stateValue_0);
    state_0.setOperation('update_color', new __compactRuntime.ContractOperation());
    state_0.setOperation('update_costs', new __compactRuntime.ContractOperation());
    state_0.setOperation('update_default_field', new __compactRuntime.ContractOperation());
    state_0.setOperation('add_multiple_fields', new __compactRuntime.ContractOperation());
    state_0.setOperation('clear_field', new __compactRuntime.ContractOperation());
    state_0.setOperation('clear_all_fields', new __compactRuntime.ContractOperation());
    state_0.setOperation('register_domain_for', new __compactRuntime.ContractOperation());
    state_0.setOperation('set_resolver', new __compactRuntime.ContractOperation());
    state_0.setOperation('update_domain_target', new __compactRuntime.ContractOperation());
    state_0.setOperation('transfer_domain', new __compactRuntime.ContractOperation());
    state_0.setOperation('change_owner', new __compactRuntime.ContractOperation());
    const context = __compactRuntime.createCircuitContext('constructor', __compactRuntime.dummyContractAddress(), constructorContext_0.initialZswapLocalState.coinPublicKey, state_0.data, constructorContext_0.initialPrivateState);
    const partialProofData = {
      input: { value: [], alignment: [] },
      output: undefined,
      publicTranscript: [],
      privateTranscriptOutputs: []
    };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(0n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_21.toValue({ is_some: false, value: new Uint8Array(32) }),
                                                                                              alignment: _descriptor_21.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(1n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_6.toValue({ bytes: new Uint8Array(32) }),
                                                                                              alignment: _descriptor_6.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(2n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_21.toValue({ is_some: false, value: new Uint8Array(32) }),
                                                                                              alignment: _descriptor_21.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(3n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue([new Uint8Array(32), { bytes: new Uint8Array(32) }]),
                                                                                              alignment: _descriptor_2.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(4n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_9.toValue({ is_left: false, left: { bytes: new Uint8Array(32) }, right: { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: new Uint8Array(32) } } }),
                                                                                              alignment: _descriptor_9.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(5n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(6n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(7n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(8n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_14.toValue({ is_some: false, value: '' }),
                                                                                              alignment: _descriptor_14.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(9n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(false),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(10n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new Uint8Array(32)),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(11n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(0n),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(12n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(0n),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(13n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(0n),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    const target_type_0 = target_0[1];
    if (target_type_0 === 0) {
      const tmp_0 = this._left_1({ bytes: target_0[0] });
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(4n),
                                                                                                alignment: _descriptor_3.alignment() }).encode() } },
                                         { push: { storage: true,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_9.toValue(tmp_0),
                                                                                                alignment: _descriptor_9.alignment() }).encode() } },
                                         { ins: { cached: false, n: 1 } }]);
    } else {
      if (target_type_0 === 1) {
        const tmp_1 = this._right_0(this._left_0({ bytes: target_0[0] }));
        __compactRuntime.queryLedgerState(context,
                                          partialProofData,
                                          [
                                           { push: { storage: false,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(4n),
                                                                                                  alignment: _descriptor_3.alignment() }).encode() } },
                                           { push: { storage: true,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_9.toValue(tmp_1),
                                                                                                  alignment: _descriptor_9.alignment() }).encode() } },
                                           { ins: { cached: false, n: 1 } }]);
      } else {
        const tmp_2 = this._right_0(this._right_1({ bytes: target_0[0] }));
        __compactRuntime.queryLedgerState(context,
                                          partialProofData,
                                          [
                                           { push: { storage: false,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(4n),
                                                                                                  alignment: _descriptor_3.alignment() }).encode() } },
                                           { push: { storage: true,
                                                     value: __compactRuntime.StateValue.newCell({ value: _descriptor_9.toValue(tmp_2),
                                                                                                  alignment: _descriptor_9.alignment() }).encode() } },
                                           { ins: { cached: false, n: 1 } }]);
      }
    }
    const tmp_3 = [owner_pubkey_0, owner_address_0];
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(3n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(tmp_3),
                                                                                              alignment: _descriptor_2.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(0n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_21.toValue(parent_domain_0),
                                                                                              alignment: _descriptor_21.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(1n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_6.toValue(parent_resolver_0),
                                                                                              alignment: _descriptor_6.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(2n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_21.toValue(domain_0),
                                                                                              alignment: _descriptor_21.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(9n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(buy_enabled_0),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(10n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(coin_color_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(11n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(cost_short_0),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(12n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(cost_med_0),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(13n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(cost_long_0),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(8n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_14.toValue(default_field_0),
                                                                                              alignment: _descriptor_14.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    await this._folder_0(context,
                         partialProofData,
                         (async (context, partialProofData, t_0, kv_0) =>
                          {
                            if (!this._equal_0(kv_0, this._none_0())) {
                              const tmp_4 = kv_0.value[0];
                              const tmp_5 = kv_0.value[1];
                              __compactRuntime.queryLedgerState(context,
                                                                partialProofData,
                                                                [
                                                                 { idx: { cached: false,
                                                                          pushPath: true,
                                                                          path: [
                                                                                 { tag: 'value',
                                                                                   value: { value: _descriptor_3.toValue(7n),
                                                                                            alignment: _descriptor_3.alignment() } }] } },
                                                                 { push: { storage: false,
                                                                           value: __compactRuntime.StateValue.newCell({ value: _descriptor_13.toValue(tmp_4),
                                                                                                                        alignment: _descriptor_13.alignment() }).encode() } },
                                                                 { push: { storage: true,
                                                                           value: __compactRuntime.StateValue.newCell({ value: _descriptor_13.toValue(tmp_5),
                                                                                                                        alignment: _descriptor_13.alignment() }).encode() } },
                                                                 { ins: { cached: false,
                                                                          n: 1 } },
                                                                 { ins: { cached: true,
                                                                          n: 1 } }]);
                            }
                            return t_0;
                          }),
                         [],
                         kvs_0);
    state_0.data = new __compactRuntime.ChargedState(context.callContext.currentQueryContext.state.state);
    return {
      currentContractState: state_0,
      currentPrivateState: context.callContext.currentPrivateState,
      currentZswapLocalState: context.callContext.currentZswapLocalState
    }
  }
  _none_0() { return { is_some: false, value: ['', ''] }; }
  _left_0(value_0) {
    return { is_left: true, left: value_0, right: { bytes: new Uint8Array(32) } };
  }
  _left_1(value_0) {
    return { is_left: true,
             left: value_0,
             right:
               { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: new Uint8Array(32) } } };
  }
  _left_2(value_0) {
    return { is_left: true, left: value_0, right: new Uint8Array(32) };
  }
  _right_0(value_0) {
    return { is_left: false, left: { bytes: new Uint8Array(32) }, right: value_0 };
  }
  _right_1(value_0) {
    return { is_left: false, left: { bytes: new Uint8Array(32) }, right: value_0 };
  }
  _right_2(value_0) {
    return { is_left: false, left: { bytes: new Uint8Array(32) }, right: value_0 };
  }
  async _sendUnshielded_0(context,
                          partialProofData,
                          color_0,
                          amount_0,
                          recipient_0)
  {
    const tmp_0 = this._left_2(color_0);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { swap: { n: 0 } },
                                       { idx: { cached: true,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(7n),
                                                                  alignment: _descriptor_3.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_18.toValue(tmp_0),
                                                                                              alignment: _descriptor_18.alignment() }).encode() } },
                                       { dup: { n: 1 } },
                                       { dup: { n: 1 } },
                                       'member',
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(amount_0),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { swap: { n: 0 } },
                                       'neg',
                                       { branch: { skip: 4 } },
                                       { dup: { n: 2 } },
                                       { dup: { n: 2 } },
                                       { idx: { cached: true,
                                                pushPath: false,
                                                path: [ { tag: 'stack' }] } },
                                       'add',
                                       { ins: { cached: true, n: 2 } },
                                       { swap: { n: 0 } }]);
    const tmp_1 = this._left_2(color_0);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { swap: { n: 0 } },
                                       { idx: { cached: true,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(8n),
                                                                  alignment: _descriptor_3.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell(__compactRuntime.alignedConcat(
                                                                                              { value: _descriptor_18.toValue(tmp_1),
                                                                                                alignment: _descriptor_18.alignment() },
                                                                                              { value: _descriptor_20.toValue(recipient_0),
                                                                                                alignment: _descriptor_20.alignment() }
                                                                                            )).encode() } },
                                       { dup: { n: 1 } },
                                       { dup: { n: 1 } },
                                       'member',
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(amount_0),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { swap: { n: 0 } },
                                       'neg',
                                       { branch: { skip: 4 } },
                                       { dup: { n: 2 } },
                                       { dup: { n: 2 } },
                                       { idx: { cached: true,
                                                pushPath: false,
                                                path: [ { tag: 'stack' }] } },
                                       'add',
                                       { ins: { cached: true, n: 2 } },
                                       { swap: { n: 0 } }]);
    if (recipient_0.is_left
        &&
        this._equal_1(recipient_0.left.bytes,
                      _descriptor_6.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                partialProofData,
                                                                                [
                                                                                 { dup: { n: 2 } },
                                                                                 { idx: { cached: true,
                                                                                          pushPath: false,
                                                                                          path: [
                                                                                                 { tag: 'value',
                                                                                                   value: { value: _descriptor_3.toValue(0n),
                                                                                                            alignment: _descriptor_3.alignment() } }] } },
                                                                                 { popeq: { cached: true,
                                                                                            result: undefined } }]).value).bytes))
    {
      const tmp_2 = this._left_2(color_0);
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { swap: { n: 0 } },
                                         { idx: { cached: true,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_3.toValue(6n),
                                                                    alignment: _descriptor_3.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_18.toValue(tmp_2),
                                                                                                alignment: _descriptor_18.alignment() }).encode() } },
                                         { dup: { n: 1 } },
                                         { dup: { n: 1 } },
                                         'member',
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(amount_0),
                                                                                                alignment: _descriptor_12.alignment() }).encode() } },
                                         { swap: { n: 0 } },
                                         'neg',
                                         { branch: { skip: 4 } },
                                         { dup: { n: 2 } },
                                         { dup: { n: 2 } },
                                         { idx: { cached: true,
                                                  pushPath: false,
                                                  path: [ { tag: 'stack' }] } },
                                         'add',
                                         { ins: { cached: true, n: 2 } },
                                         { swap: { n: 0 } }]);
    }
    return [];
  }
  async _receiveUnshielded_0(context, partialProofData, color_0, amount_0) {
    const tmp_0 = this._left_2(color_0);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { swap: { n: 0 } },
                                       { idx: { cached: true,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(6n),
                                                                  alignment: _descriptor_3.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_18.toValue(tmp_0),
                                                                                              alignment: _descriptor_18.alignment() }).encode() } },
                                       { dup: { n: 1 } },
                                       { dup: { n: 1 } },
                                       'member',
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(amount_0),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { swap: { n: 0 } },
                                       'neg',
                                       { branch: { skip: 4 } },
                                       { dup: { n: 2 } },
                                       { dup: { n: 2 } },
                                       { idx: { cached: true,
                                                pushPath: false,
                                                path: [ { tag: 'stack' }] } },
                                       'add',
                                       { ins: { cached: true, n: 2 } },
                                       { swap: { n: 0 } }]);
    return [];
  }
  _persistentHash_0(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_19, value_0);
    return result_0;
  }
  async _update_color_0(context, partialProofData, c_0) {
    await this._assert_is_owner_0(context, partialProofData);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(10n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(c_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    return [];
  }
  async _update_costs_0(context,
                        partialProofData,
                        cost_short_0,
                        cost_med_0,
                        cost_long_0,
                        enabled_0)
  {
    await this._assert_is_owner_0(context, partialProofData);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(11n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(cost_short_0),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(12n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(cost_med_0),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(13n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_12.toValue(cost_long_0),
                                                                                              alignment: _descriptor_12.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(9n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(enabled_0),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    return [];
  }
  async _update_default_field_0(context, partialProofData, d_0) {
    await this._assert_is_owner_0(context, partialProofData);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(8n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_14.toValue(d_0),
                                                                                              alignment: _descriptor_14.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    return [];
  }
  async _add_multiple_fields_0(context, partialProofData, kvs_0) {
    await this._assert_is_owner_0(context, partialProofData);
    await this._folder_1(context,
                         partialProofData,
                         (async (context, partialProofData, t_0, kv_0) =>
                          {
                            if (!this._equal_2(kv_0, this._none_0())) {
                              const tmp_0 = kv_0.value[0];
                              const tmp_1 = kv_0.value[1];
                              __compactRuntime.queryLedgerState(context,
                                                                partialProofData,
                                                                [
                                                                 { idx: { cached: false,
                                                                          pushPath: true,
                                                                          path: [
                                                                                 { tag: 'value',
                                                                                   value: { value: _descriptor_3.toValue(7n),
                                                                                            alignment: _descriptor_3.alignment() } }] } },
                                                                 { push: { storage: false,
                                                                           value: __compactRuntime.StateValue.newCell({ value: _descriptor_13.toValue(tmp_0),
                                                                                                                        alignment: _descriptor_13.alignment() }).encode() } },
                                                                 { push: { storage: true,
                                                                           value: __compactRuntime.StateValue.newCell({ value: _descriptor_13.toValue(tmp_1),
                                                                                                                        alignment: _descriptor_13.alignment() }).encode() } },
                                                                 { ins: { cached: false,
                                                                          n: 1 } },
                                                                 { ins: { cached: true,
                                                                          n: 1 } }]);
                            }
                            return t_0;
                          }),
                         [],
                         kvs_0);
    return [];
  }
  async _clear_field_0(context, partialProofData, k_0) {
    await this._assert_is_owner_0(context, partialProofData);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(7n),
                                                                  alignment: _descriptor_3.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_13.toValue(k_0),
                                                                                              alignment: _descriptor_13.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 1 } }]);
    return [];
  }
  async _clear_all_fields_0(context, partialProofData) {
    await this._assert_is_owner_0(context, partialProofData);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(7n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    return [];
  }
  async _register_domain_for_0(context,
                               partialProofData,
                               owner_0,
                               domain_0,
                               len_0,
                               resolver_0)
  {
    __compactRuntime.assert(len_0 <= 32n, 'len must be <= 32');
    __compactRuntime.assert(len_0 >= 1n, 'domain name cannot be empty');
    const valid_0 = this._verify_domain_path_0(domain_0, len_0);
    __compactRuntime.assert(valid_0, 'Invalid domain key padding');
    __compactRuntime.assert(!_descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                       partialProofData,
                                                                                       [
                                                                                        { dup: { n: 0 } },
                                                                                        { idx: { cached: false,
                                                                                                 pushPath: false,
                                                                                                 path: [
                                                                                                        { tag: 'value',
                                                                                                          value: { value: _descriptor_3.toValue(5n),
                                                                                                                   alignment: _descriptor_3.alignment() } }] } },
                                                                                        { push: { storage: false,
                                                                                                  value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(domain_0),
                                                                                                                                               alignment: _descriptor_0.alignment() }).encode() } },
                                                                                        'member',
                                                                                        { popeq: { cached: true,
                                                                                                   result: undefined } }]).value),
                            'Domain already exists');
    if (this._equal_3(await this._derive_public_key_0(context, partialProofData),
                      _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                partialProofData,
                                                                                [
                                                                                 { dup: { n: 0 } },
                                                                                 { idx: { cached: false,
                                                                                          pushPath: false,
                                                                                          path: [
                                                                                                 { tag: 'value',
                                                                                                   value: { value: _descriptor_3.toValue(3n),
                                                                                                            alignment: _descriptor_3.alignment() } }] } },
                                                                                 { popeq: { cached: false,
                                                                                            result: undefined } }]).value)[0]))
    {
    } else {
      __compactRuntime.assert(_descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                        partialProofData,
                                                                                        [
                                                                                         { dup: { n: 0 } },
                                                                                         { idx: { cached: false,
                                                                                                  pushPath: false,
                                                                                                  path: [
                                                                                                         { tag: 'value',
                                                                                                           value: { value: _descriptor_3.toValue(9n),
                                                                                                                    alignment: _descriptor_3.alignment() } }] } },
                                                                                         { popeq: { cached: false,
                                                                                                    result: undefined } }]).value),
                              'buying domains is not enabled');
      const d_len_0 = len_0;
      if (d_len_0 <= 3n) {
        await this._receiveUnshielded_0(context,
                                        partialProofData,
                                        _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                  partialProofData,
                                                                                                  [
                                                                                                   { dup: { n: 0 } },
                                                                                                   { idx: { cached: false,
                                                                                                            pushPath: false,
                                                                                                            path: [
                                                                                                                   { tag: 'value',
                                                                                                                     value: { value: _descriptor_3.toValue(10n),
                                                                                                                              alignment: _descriptor_3.alignment() } }] } },
                                                                                                   { popeq: { cached: false,
                                                                                                              result: undefined } }]).value),
                                        _descriptor_12.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                   partialProofData,
                                                                                                   [
                                                                                                    { dup: { n: 0 } },
                                                                                                    { idx: { cached: false,
                                                                                                             pushPath: false,
                                                                                                             path: [
                                                                                                                    { tag: 'value',
                                                                                                                      value: { value: _descriptor_3.toValue(11n),
                                                                                                                               alignment: _descriptor_3.alignment() } }] } },
                                                                                                    { popeq: { cached: false,
                                                                                                               result: undefined } }]).value));
        await this._sendUnshielded_0(context,
                                     partialProofData,
                                     _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                               partialProofData,
                                                                                               [
                                                                                                { dup: { n: 0 } },
                                                                                                { idx: { cached: false,
                                                                                                         pushPath: false,
                                                                                                         path: [
                                                                                                                { tag: 'value',
                                                                                                                  value: { value: _descriptor_3.toValue(10n),
                                                                                                                           alignment: _descriptor_3.alignment() } }] } },
                                                                                                { popeq: { cached: false,
                                                                                                           result: undefined } }]).value),
                                     _descriptor_12.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                partialProofData,
                                                                                                [
                                                                                                 { dup: { n: 0 } },
                                                                                                 { idx: { cached: false,
                                                                                                          pushPath: false,
                                                                                                          path: [
                                                                                                                 { tag: 'value',
                                                                                                                   value: { value: _descriptor_3.toValue(11n),
                                                                                                                            alignment: _descriptor_3.alignment() } }] } },
                                                                                                 { popeq: { cached: false,
                                                                                                            result: undefined } }]).value),
                                     this._right_2(_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                             partialProofData,
                                                                                                             [
                                                                                                              { dup: { n: 0 } },
                                                                                                              { idx: { cached: false,
                                                                                                                       pushPath: false,
                                                                                                                       path: [
                                                                                                                              { tag: 'value',
                                                                                                                                value: { value: _descriptor_3.toValue(3n),
                                                                                                                                         alignment: _descriptor_3.alignment() } }] } },
                                                                                                              { popeq: { cached: false,
                                                                                                                         result: undefined } }]).value)[1]));
      } else {
        if (d_len_0 === 4n) {
          await this._receiveUnshielded_0(context,
                                          partialProofData,
                                          _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                    partialProofData,
                                                                                                    [
                                                                                                     { dup: { n: 0 } },
                                                                                                     { idx: { cached: false,
                                                                                                              pushPath: false,
                                                                                                              path: [
                                                                                                                     { tag: 'value',
                                                                                                                       value: { value: _descriptor_3.toValue(10n),
                                                                                                                                alignment: _descriptor_3.alignment() } }] } },
                                                                                                     { popeq: { cached: false,
                                                                                                                result: undefined } }]).value),
                                          _descriptor_12.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                     partialProofData,
                                                                                                     [
                                                                                                      { dup: { n: 0 } },
                                                                                                      { idx: { cached: false,
                                                                                                               pushPath: false,
                                                                                                               path: [
                                                                                                                      { tag: 'value',
                                                                                                                        value: { value: _descriptor_3.toValue(12n),
                                                                                                                                 alignment: _descriptor_3.alignment() } }] } },
                                                                                                      { popeq: { cached: false,
                                                                                                                 result: undefined } }]).value));
          await this._sendUnshielded_0(context,
                                       partialProofData,
                                       _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                 partialProofData,
                                                                                                 [
                                                                                                  { dup: { n: 0 } },
                                                                                                  { idx: { cached: false,
                                                                                                           pushPath: false,
                                                                                                           path: [
                                                                                                                  { tag: 'value',
                                                                                                                    value: { value: _descriptor_3.toValue(10n),
                                                                                                                             alignment: _descriptor_3.alignment() } }] } },
                                                                                                  { popeq: { cached: false,
                                                                                                             result: undefined } }]).value),
                                       _descriptor_12.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                  partialProofData,
                                                                                                  [
                                                                                                   { dup: { n: 0 } },
                                                                                                   { idx: { cached: false,
                                                                                                            pushPath: false,
                                                                                                            path: [
                                                                                                                   { tag: 'value',
                                                                                                                     value: { value: _descriptor_3.toValue(12n),
                                                                                                                              alignment: _descriptor_3.alignment() } }] } },
                                                                                                   { popeq: { cached: false,
                                                                                                              result: undefined } }]).value),
                                       this._right_2(_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                               partialProofData,
                                                                                                               [
                                                                                                                { dup: { n: 0 } },
                                                                                                                { idx: { cached: false,
                                                                                                                         pushPath: false,
                                                                                                                         path: [
                                                                                                                                { tag: 'value',
                                                                                                                                  value: { value: _descriptor_3.toValue(3n),
                                                                                                                                           alignment: _descriptor_3.alignment() } }] } },
                                                                                                                { popeq: { cached: false,
                                                                                                                           result: undefined } }]).value)[1]));
        } else {
          await this._receiveUnshielded_0(context,
                                          partialProofData,
                                          _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                    partialProofData,
                                                                                                    [
                                                                                                     { dup: { n: 0 } },
                                                                                                     { idx: { cached: false,
                                                                                                              pushPath: false,
                                                                                                              path: [
                                                                                                                     { tag: 'value',
                                                                                                                       value: { value: _descriptor_3.toValue(10n),
                                                                                                                                alignment: _descriptor_3.alignment() } }] } },
                                                                                                     { popeq: { cached: false,
                                                                                                                result: undefined } }]).value),
                                          _descriptor_12.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                     partialProofData,
                                                                                                     [
                                                                                                      { dup: { n: 0 } },
                                                                                                      { idx: { cached: false,
                                                                                                               pushPath: false,
                                                                                                               path: [
                                                                                                                      { tag: 'value',
                                                                                                                        value: { value: _descriptor_3.toValue(13n),
                                                                                                                                 alignment: _descriptor_3.alignment() } }] } },
                                                                                                      { popeq: { cached: false,
                                                                                                                 result: undefined } }]).value));
          await this._sendUnshielded_0(context,
                                       partialProofData,
                                       _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                 partialProofData,
                                                                                                 [
                                                                                                  { dup: { n: 0 } },
                                                                                                  { idx: { cached: false,
                                                                                                           pushPath: false,
                                                                                                           path: [
                                                                                                                  { tag: 'value',
                                                                                                                    value: { value: _descriptor_3.toValue(10n),
                                                                                                                             alignment: _descriptor_3.alignment() } }] } },
                                                                                                  { popeq: { cached: false,
                                                                                                             result: undefined } }]).value),
                                       _descriptor_12.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                  partialProofData,
                                                                                                  [
                                                                                                   { dup: { n: 0 } },
                                                                                                   { idx: { cached: false,
                                                                                                            pushPath: false,
                                                                                                            path: [
                                                                                                                   { tag: 'value',
                                                                                                                     value: { value: _descriptor_3.toValue(13n),
                                                                                                                              alignment: _descriptor_3.alignment() } }] } },
                                                                                                   { popeq: { cached: false,
                                                                                                              result: undefined } }]).value),
                                       this._right_2(_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                               partialProofData,
                                                                                                               [
                                                                                                                { dup: { n: 0 } },
                                                                                                                { idx: { cached: false,
                                                                                                                         pushPath: false,
                                                                                                                         path: [
                                                                                                                                { tag: 'value',
                                                                                                                                  value: { value: _descriptor_3.toValue(3n),
                                                                                                                                           alignment: _descriptor_3.alignment() } }] } },
                                                                                                                { popeq: { cached: false,
                                                                                                                           result: undefined } }]).value)[1]));
        }
      }
    }
    const d_owner_0 = owner_0;
    const domain_data_0 = { owner: d_owner_0, resolver: resolver_0 };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(5n),
                                                                  alignment: _descriptor_3.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(domain_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_10.toValue(domain_data_0),
                                                                                              alignment: _descriptor_10.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    if (!_descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                   partialProofData,
                                                                   [
                                                                    { dup: { n: 0 } },
                                                                    { idx: { cached: false,
                                                                             pushPath: false,
                                                                             path: [
                                                                                    { tag: 'value',
                                                                                      value: { value: _descriptor_3.toValue(6n),
                                                                                               alignment: _descriptor_3.alignment() } }] } },
                                                                    { push: { storage: false,
                                                                              value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(d_owner_0),
                                                                                                                           alignment: _descriptor_0.alignment() }).encode() } },
                                                                    'member',
                                                                    { popeq: { cached: true,
                                                                               result: undefined } }]).value))
    {
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { idx: { cached: false,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_3.toValue(6n),
                                                                    alignment: _descriptor_3.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(d_owner_0),
                                                                                                alignment: _descriptor_0.alignment() }).encode() } },
                                         { push: { storage: true,
                                                   value: __compactRuntime.StateValue.newMap(
                                                            new __compactRuntime.StateMap()
                                                          ).encode() } },
                                         { ins: { cached: false, n: 1 } },
                                         { ins: { cached: true, n: 1 } }]);
    }
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(6n),
                                                                  alignment: _descriptor_3.alignment() } },
                                                       { tag: 'value',
                                                         value: { value: _descriptor_0.toValue(d_owner_0),
                                                                  alignment: _descriptor_0.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(domain_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newNull().encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 2 } }]);
    return [];
  }
  async _set_resolver_0(context, partialProofData, domain_0, resolver_0) {
    __compactRuntime.assert(_descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_3.toValue(5n),
                                                                                                                  alignment: _descriptor_3.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(domain_0),
                                                                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'Domain does not exist');
    const current_data_0 = _descriptor_10.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_3.toValue(5n),
                                                                                                                  alignment: _descriptor_3.alignment() } }] } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_0.toValue(domain_0),
                                                                                                                  alignment: _descriptor_0.alignment() } }] } },
                                                                                       { popeq: { cached: false,
                                                                                                  result: undefined } }]).value);
    __compactRuntime.assert(this._equal_4(current_data_0.owner,
                                          await this._derive_public_key_0(context,
                                                                          partialProofData)),
                            'Not the domain owner');
    const new_data_0 = { owner: current_data_0.owner, resolver: resolver_0 };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(5n),
                                                                  alignment: _descriptor_3.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(domain_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_10.toValue(new_data_0),
                                                                                              alignment: _descriptor_10.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    return [];
  }
  async _update_domain_target_0(context, partialProofData, new_target_0) {
    await this._assert_is_owner_0(context, partialProofData);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(4n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_9.toValue(new_target_0),
                                                                                              alignment: _descriptor_9.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    return [];
  }
  async _transfer_domain_0(context, partialProofData, domain_0, new_owner_0) {
    __compactRuntime.assert(_descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_3.toValue(5n),
                                                                                                                  alignment: _descriptor_3.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(domain_0),
                                                                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'Domain does not exist');
    const current_data_0 = _descriptor_10.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_3.toValue(5n),
                                                                                                                  alignment: _descriptor_3.alignment() } }] } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_0.toValue(domain_0),
                                                                                                                  alignment: _descriptor_0.alignment() } }] } },
                                                                                       { popeq: { cached: false,
                                                                                                  result: undefined } }]).value);
    __compactRuntime.assert(this._equal_5(current_data_0.owner,
                                          await this._derive_public_key_0(context,
                                                                          partialProofData)),
                            'Not the domain owner');
    const new_data_0 = { owner: new_owner_0, resolver: current_data_0.resolver };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(5n),
                                                                  alignment: _descriptor_3.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(domain_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_10.toValue(new_data_0),
                                                                                              alignment: _descriptor_10.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    const tmp_0 = await this._derive_public_key_0(context, partialProofData);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(6n),
                                                                  alignment: _descriptor_3.alignment() } },
                                                       { tag: 'value',
                                                         value: { value: _descriptor_0.toValue(tmp_0),
                                                                  alignment: _descriptor_0.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(domain_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 2 } }]);
    if (!_descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                   partialProofData,
                                                                   [
                                                                    { dup: { n: 0 } },
                                                                    { idx: { cached: false,
                                                                             pushPath: false,
                                                                             path: [
                                                                                    { tag: 'value',
                                                                                      value: { value: _descriptor_3.toValue(6n),
                                                                                               alignment: _descriptor_3.alignment() } }] } },
                                                                    { push: { storage: false,
                                                                              value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new_owner_0),
                                                                                                                           alignment: _descriptor_0.alignment() }).encode() } },
                                                                    'member',
                                                                    { popeq: { cached: true,
                                                                               result: undefined } }]).value))
    {
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { idx: { cached: false,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_3.toValue(6n),
                                                                    alignment: _descriptor_3.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new_owner_0),
                                                                                                alignment: _descriptor_0.alignment() }).encode() } },
                                         { push: { storage: true,
                                                   value: __compactRuntime.StateValue.newMap(
                                                            new __compactRuntime.StateMap()
                                                          ).encode() } },
                                         { ins: { cached: false, n: 1 } },
                                         { ins: { cached: true, n: 1 } }]);
    }
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(6n),
                                                                  alignment: _descriptor_3.alignment() } },
                                                       { tag: 'value',
                                                         value: { value: _descriptor_0.toValue(new_owner_0),
                                                                  alignment: _descriptor_0.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(domain_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newNull().encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 2 } }]);
    return [];
  }
  async _change_owner_0(context, partialProofData, new_owner_0, new_address_0) {
    await this._assert_is_owner_0(context, partialProofData);
    const tmp_0 = [new_owner_0, new_address_0];
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(3n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(tmp_0),
                                                                                              alignment: _descriptor_2.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    return [];
  }
  _verify_domain_path_0(domain_0, len_0) {
    return this._folder_2(((acc_0, byte_0, i_0) =>
                           {
                             return acc_0
                                    &&
                                    (i_0 < len_0
                                     &&
                                     (this._is_letter_0(byte_0)
                                      ||
                                      this._is_number_0(byte_0)
                                      ||
                                      this._is_hyphen_0(byte_0))
                                     &&
                                     !(i_0 === 0n && this._is_hyphen_0(byte_0))
                                     &&
                                     !(i_0
                                       ===
                                       (__compactRuntime.assert(len_0 >= 1n,
                                                                'result of subtraction would be negative'),
                                        len_0 - 1n)
                                       &&
                                       this._is_hyphen_0(byte_0))
                                     ||
                                     i_0 >= len_0 && this._is_padding_0(byte_0));
                           }),
                          true,
                          domain_0,
                          [0n,
                           1n,
                           2n,
                           3n,
                           4n,
                           5n,
                           6n,
                           7n,
                           8n,
                           9n,
                           10n,
                           11n,
                           12n,
                           13n,
                           14n,
                           15n,
                           16n,
                           17n,
                           18n,
                           19n,
                           20n,
                           21n,
                           22n,
                           23n,
                           24n,
                           25n,
                           26n,
                           27n,
                           28n,
                           29n,
                           30n,
                           31n]);
  }
  _is_letter_0(byte_0) { return 97n <= byte_0 && byte_0 <= 122n; }
  _is_number_0(byte_0) { return 48n <= byte_0 && byte_0 <= 57n; }
  _is_hyphen_0(byte_0) { return byte_0 === 45n; }
  _is_padding_0(byte_0) { return byte_0 === 255n; }
  _secretKey_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.callContext.currentQueryContext.state), context.callContext.currentPrivateState, context.callContext.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.secretKey(witnessContext_0);
    context.callContext.currentPrivateState = nextPrivateState_0;
    if (!(result_0.buffer instanceof ArrayBuffer && result_0.BYTES_PER_ELEMENT === 1 && result_0.length === 32)) {
      __compactRuntime.typeError('secretKey',
                                 'return value',
                                 'midnames.compact line 278 char 1',
                                 'Bytes<32>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_0.toValue(result_0),
      alignment: _descriptor_0.alignment()
    });
    return result_0;
  }
  async _assert_is_owner_0(context, partialProofData) {
    __compactRuntime.assert(this._equal_6(await this._derive_public_key_0(context,
                                                                          partialProofData),
                                          _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                    partialProofData,
                                                                                                    [
                                                                                                     { dup: { n: 0 } },
                                                                                                     { idx: { cached: false,
                                                                                                              pushPath: false,
                                                                                                              path: [
                                                                                                                     { tag: 'value',
                                                                                                                       value: { value: _descriptor_3.toValue(3n),
                                                                                                                                alignment: _descriptor_3.alignment() } }] } },
                                                                                                     { popeq: { cached: false,
                                                                                                                result: undefined } }]).value)[0]),
                            'Not the domain owner');
    return [];
  }
  async _derive_public_key_0(context, partialProofData) {
    const tag_0 = new Uint8Array([109, 105, 100, 110, 105, 103, 104, 116, 46, 100, 111, 109, 97, 105, 110, 115, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    return this._persistentHash_0([tag_0,
                                   this._secretKey_0(context, partialProofData)]);
  }
  _equal_0(x0, y0) {
    {
      let x1 = x0.is_some;
      let y1 = y0.is_some;
      if (x1 !== y1) { return false; }
    }
    {
      let x1 = x0.value;
      let y1 = y0.value;
      {
        let x2 = x1[0];
        let y2 = y1[0];
        if (x2 !== y2) { return false; }
      }
      {
        let x2 = x1[1];
        let y2 = y1[1];
        if (x2 !== y2) { return false; }
      }
    }
    return true;
  }
  async _folder_0(context, partialProofData, f, x, a0) {
    for (let i = 0; i < 10; i++) { x = await f(context, partialProofData, x, a0[i]); }
    return x;
  }
  _equal_1(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_2(x0, y0) {
    {
      let x1 = x0.is_some;
      let y1 = y0.is_some;
      if (x1 !== y1) { return false; }
    }
    {
      let x1 = x0.value;
      let y1 = y0.value;
      {
        let x2 = x1[0];
        let y2 = y1[0];
        if (x2 !== y2) { return false; }
      }
      {
        let x2 = x1[1];
        let y2 = y1[1];
        if (x2 !== y2) { return false; }
      }
    }
    return true;
  }
  async _folder_1(context, partialProofData, f, x, a0) {
    for (let i = 0; i < 10; i++) { x = await f(context, partialProofData, x, a0[i]); }
    return x;
  }
  _equal_3(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_4(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_5(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _folder_2(f, x, a0, a1) {
    for (let i = 0; i < 32; i++) { x = f(x, BigInt(a0[i]), a1[i]); }
    return x;
  }
  _equal_6(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
}
export function ledger(stateOrChargedState) {
  const state = stateOrChargedState instanceof __compactRuntime.StateValue ? stateOrChargedState : stateOrChargedState.state;
  const chargedState = stateOrChargedState instanceof __compactRuntime.StateValue ? new __compactRuntime.ChargedState(stateOrChargedState) : stateOrChargedState;
  const context = {
    callContext: { currentQueryContext: new __compactRuntime.QueryContext(chargedState, __compactRuntime.dummyContractAddress()), currentGasCost: __compactRuntime.emptyRunningCost() },
    costModel: __compactRuntime.CostModel.initialCostModel()
  };
  const partialProofData = {
    input: { value: [], alignment: [] },
    output: undefined,
    publicTranscript: [],
    privateTranscriptOutputs: []
  };
  return {
    get PARENT_DOMAIN() {
      return _descriptor_21.fromValue(__compactRuntime.queryLedgerState(context,
                                                                        partialProofData,
                                                                        [
                                                                         { dup: { n: 0 } },
                                                                         { idx: { cached: false,
                                                                                  pushPath: false,
                                                                                  path: [
                                                                                         { tag: 'value',
                                                                                           value: { value: _descriptor_3.toValue(0n),
                                                                                                    alignment: _descriptor_3.alignment() } }] } },
                                                                         { popeq: { cached: false,
                                                                                    result: undefined } }]).value);
    },
    get PARENT_RESOLVER() {
      return _descriptor_6.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_3.toValue(1n),
                                                                                                   alignment: _descriptor_3.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get DOMAIN() {
      return _descriptor_21.fromValue(__compactRuntime.queryLedgerState(context,
                                                                        partialProofData,
                                                                        [
                                                                         { dup: { n: 0 } },
                                                                         { idx: { cached: false,
                                                                                  pushPath: false,
                                                                                  path: [
                                                                                         { tag: 'value',
                                                                                           value: { value: _descriptor_3.toValue(2n),
                                                                                                    alignment: _descriptor_3.alignment() } }] } },
                                                                         { popeq: { cached: false,
                                                                                    result: undefined } }]).value);
    },
    get DOMAIN_OWNER() {
      return _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_3.toValue(3n),
                                                                                                   alignment: _descriptor_3.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get DOMAIN_TARGET() {
      return _descriptor_9.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_3.toValue(4n),
                                                                                                   alignment: _descriptor_3.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    domains: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_3.toValue(5n),
                                                                                                     alignment: _descriptor_3.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_11.toValue(0n),
                                                                                                                                 alignment: _descriptor_11.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_11.fromValue(__compactRuntime.queryLedgerState(context,
                                                                          partialProofData,
                                                                          [
                                                                           { dup: { n: 0 } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_3.toValue(5n),
                                                                                                      alignment: _descriptor_3.alignment() } }] } },
                                                                           'size',
                                                                           { popeq: { cached: true,
                                                                                      result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'midnames.compact line 40 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_3.toValue(5n),
                                                                                                     alignment: _descriptor_3.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                 alignment: _descriptor_0.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'midnames.compact line 40 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_10.fromValue(__compactRuntime.queryLedgerState(context,
                                                                          partialProofData,
                                                                          [
                                                                           { dup: { n: 0 } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_3.toValue(5n),
                                                                                                      alignment: _descriptor_3.alignment() } }] } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_0.toValue(key_0),
                                                                                                      alignment: _descriptor_0.alignment() } }] } },
                                                                           { popeq: { cached: false,
                                                                                      result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[5];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_0.fromValue(key.value),      _descriptor_10.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    domains_owned: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_3.toValue(6n),
                                                                                                     alignment: _descriptor_3.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_11.toValue(0n),
                                                                                                                                 alignment: _descriptor_11.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_11.fromValue(__compactRuntime.queryLedgerState(context,
                                                                          partialProofData,
                                                                          [
                                                                           { dup: { n: 0 } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_3.toValue(6n),
                                                                                                      alignment: _descriptor_3.alignment() } }] } },
                                                                           'size',
                                                                           { popeq: { cached: true,
                                                                                      result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'midnames.compact line 43 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_3.toValue(6n),
                                                                                                     alignment: _descriptor_3.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(key_0),
                                                                                                                                 alignment: _descriptor_0.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'midnames.compact line 43 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        if (state.asArray()[6].asMap().get({ value: _descriptor_0.toValue(key_0),
                                             alignment: _descriptor_0.alignment() }) === undefined) {
          throw new __compactRuntime.CompactError(`Map value undefined for ${key_0}`);
        }
        return {
          isEmpty(...args_1) {
            if (args_1.length !== 0) {
              throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_1.length}`);
            }
            return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                             partialProofData,
                                                                             [
                                                                              { dup: { n: 0 } },
                                                                              { idx: { cached: false,
                                                                                       pushPath: false,
                                                                                       path: [
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_3.toValue(6n),
                                                                                                         alignment: _descriptor_3.alignment() } },
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_0.toValue(key_0),
                                                                                                         alignment: _descriptor_0.alignment() } }] } },
                                                                              'size',
                                                                              { push: { storage: false,
                                                                                        value: __compactRuntime.StateValue.newCell({ value: _descriptor_11.toValue(0n),
                                                                                                                                     alignment: _descriptor_11.alignment() }).encode() } },
                                                                              'eq',
                                                                              { popeq: { cached: true,
                                                                                         result: undefined } }]).value);
          },
          size(...args_1) {
            if (args_1.length !== 0) {
              throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_1.length}`);
            }
            return _descriptor_11.fromValue(__compactRuntime.queryLedgerState(context,
                                                                              partialProofData,
                                                                              [
                                                                               { dup: { n: 0 } },
                                                                               { idx: { cached: false,
                                                                                        pushPath: false,
                                                                                        path: [
                                                                                               { tag: 'value',
                                                                                                 value: { value: _descriptor_3.toValue(6n),
                                                                                                          alignment: _descriptor_3.alignment() } },
                                                                                               { tag: 'value',
                                                                                                 value: { value: _descriptor_0.toValue(key_0),
                                                                                                          alignment: _descriptor_0.alignment() } }] } },
                                                                               'size',
                                                                               { popeq: { cached: true,
                                                                                          result: undefined } }]).value);
          },
          member(...args_1) {
            if (args_1.length !== 1) {
              throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_1.length}`);
            }
            const elem_0 = args_1[0];
            if (!(elem_0.buffer instanceof ArrayBuffer && elem_0.BYTES_PER_ELEMENT === 1 && elem_0.length === 32)) {
              __compactRuntime.typeError('member',
                                         'argument 1',
                                         'midnames.compact line 43 char 45',
                                         'Bytes<32>',
                                         elem_0)
            }
            return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                             partialProofData,
                                                                             [
                                                                              { dup: { n: 0 } },
                                                                              { idx: { cached: false,
                                                                                       pushPath: false,
                                                                                       path: [
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_3.toValue(6n),
                                                                                                         alignment: _descriptor_3.alignment() } },
                                                                                              { tag: 'value',
                                                                                                value: { value: _descriptor_0.toValue(key_0),
                                                                                                         alignment: _descriptor_0.alignment() } }] } },
                                                                              { push: { storage: false,
                                                                                        value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(elem_0),
                                                                                                                                     alignment: _descriptor_0.alignment() }).encode() } },
                                                                              'member',
                                                                              { popeq: { cached: true,
                                                                                         result: undefined } }]).value);
          },
          [Symbol.iterator](...args_1) {
            if (args_1.length !== 0) {
              throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_1.length}`);
            }
            const self_0 = state.asArray()[6].asMap().get({ value: _descriptor_0.toValue(key_0),
                                                            alignment: _descriptor_0.alignment() });
            return self_0.asMap().keys().map((elem) => _descriptor_0.fromValue(elem.value))[Symbol.iterator]();
          }
        }
      }
    },
    fields: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_3.toValue(7n),
                                                                                                     alignment: _descriptor_3.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_11.toValue(0n),
                                                                                                                                 alignment: _descriptor_11.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_11.fromValue(__compactRuntime.queryLedgerState(context,
                                                                          partialProofData,
                                                                          [
                                                                           { dup: { n: 0 } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_3.toValue(7n),
                                                                                                      alignment: _descriptor_3.alignment() } }] } },
                                                                           'size',
                                                                           { popeq: { cached: true,
                                                                                      result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_3.toValue(7n),
                                                                                                     alignment: _descriptor_3.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_13.toValue(key_0),
                                                                                                                                 alignment: _descriptor_13.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        return _descriptor_13.fromValue(__compactRuntime.queryLedgerState(context,
                                                                          partialProofData,
                                                                          [
                                                                           { dup: { n: 0 } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_3.toValue(7n),
                                                                                                      alignment: _descriptor_3.alignment() } }] } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_13.toValue(key_0),
                                                                                                      alignment: _descriptor_13.alignment() } }] } },
                                                                           { popeq: { cached: false,
                                                                                      result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[7];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_13.fromValue(key.value),      _descriptor_13.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    get DEFAULT_FIELD() {
      return _descriptor_14.fromValue(__compactRuntime.queryLedgerState(context,
                                                                        partialProofData,
                                                                        [
                                                                         { dup: { n: 0 } },
                                                                         { idx: { cached: false,
                                                                                  pushPath: false,
                                                                                  path: [
                                                                                         { tag: 'value',
                                                                                           value: { value: _descriptor_3.toValue(8n),
                                                                                                    alignment: _descriptor_3.alignment() } }] } },
                                                                         { popeq: { cached: false,
                                                                                    result: undefined } }]).value);
    },
    get BUY_ENABLED() {
      return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_3.toValue(9n),
                                                                                                   alignment: _descriptor_3.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get COIN_COLOR() {
      return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_3.toValue(10n),
                                                                                                   alignment: _descriptor_3.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get COST_SHORT() {
      return _descriptor_12.fromValue(__compactRuntime.queryLedgerState(context,
                                                                        partialProofData,
                                                                        [
                                                                         { dup: { n: 0 } },
                                                                         { idx: { cached: false,
                                                                                  pushPath: false,
                                                                                  path: [
                                                                                         { tag: 'value',
                                                                                           value: { value: _descriptor_3.toValue(11n),
                                                                                                    alignment: _descriptor_3.alignment() } }] } },
                                                                         { popeq: { cached: false,
                                                                                    result: undefined } }]).value);
    },
    get COST_MED() {
      return _descriptor_12.fromValue(__compactRuntime.queryLedgerState(context,
                                                                        partialProofData,
                                                                        [
                                                                         { dup: { n: 0 } },
                                                                         { idx: { cached: false,
                                                                                  pushPath: false,
                                                                                  path: [
                                                                                         { tag: 'value',
                                                                                           value: { value: _descriptor_3.toValue(12n),
                                                                                                    alignment: _descriptor_3.alignment() } }] } },
                                                                         { popeq: { cached: false,
                                                                                    result: undefined } }]).value);
    },
    get COST_LONG() {
      return _descriptor_12.fromValue(__compactRuntime.queryLedgerState(context,
                                                                        partialProofData,
                                                                        [
                                                                         { dup: { n: 0 } },
                                                                         { idx: { cached: false,
                                                                                  pushPath: false,
                                                                                  path: [
                                                                                         { tag: 'value',
                                                                                           value: { value: _descriptor_3.toValue(13n),
                                                                                                    alignment: _descriptor_3.alignment() } }] } },
                                                                         { popeq: { cached: false,
                                                                                    result: undefined } }]).value);
    }
  };
}
const _emptyContext = {
  callContext: { currentQueryContext: new __compactRuntime.QueryContext(new __compactRuntime.ContractState().data, __compactRuntime.dummyContractAddress()), currentGasCost: __compactRuntime.emptyRunningCost() }
};
const _dummyContract = new Contract({ secretKey: (...args) => undefined });
export const pureCircuits = {};
export const contractReferenceLocations =
  { tag: 'publicLedgerArray', indices: { } };
export const expectedVk = {
  'add_multiple_fields': '350f70d9f2e77c4fa60704415276a5f7dcc13be2f07db3aae745cf57223a5a30',
  'change_owner': 'e1b914cd9d5d4f39572a8385ff2b6803047603dc5f5c095ae778b9b3c436c72c',
  'clear_all_fields': 'f22d5f794d2e1e6475c434a3ba704bed1e41dcabb6b4c5442199d70455213c5d',
  'clear_field': '6c01627cfa1a8327db66c283fd5b70ed09cc554080efed272f0c4735f435395f',
  'register_domain_for': '0e837542afee7cc081704eb7879c675cfe346307539b3ad3fa20ae3454716104',
  'set_resolver': '0fd126e4bb603e5b7adfb852cef682771f5ae44649552318d638c1175e7c22ae',
  'transfer_domain': '442b57960a20aa561d67d118549752c4af14079b83276c43b14a410c3b8141d9',
  'update_color': 'dc40528c44f9cbdd83bee6278ed29fc57cb1a47ba57ffb20a8eb1a46ab9d27ae',
  'update_costs': '77f25d6c0f1a01dff18494730f577b932cf9541b791b9a8300cd3e3f7abaf5e9',
  'update_default_field': '62fa773d29c052fd1179ab5dbb2a8b0998c93a4f2e7fe9796d18c885e638f0a4',
  'update_domain_target': 'c36aeadc7d4afd5431208137865f693e395edf4953717df03d47161635579528',
};

//# sourceMappingURL=index.js.map
