# Official BIP340 test vectors

`test-vectors.csv` is an unmodified copy, including its original CRLF line
endings, from [bitcoin/bips at
130b8e0fa7f30fa45532f080b87b8db27a79e46e](https://github.com/bitcoin/bips/blob/130b8e0fa7f30fa45532f080b87b8db27a79e46e/bip-0340/test-vectors.csv).

- SHA-256: `34c9d1d9c3a88d524bc80778540dc43f8306ec249a7485293063c376db851c2d`
- 19 vectors: 9 valid and 10 invalid.
- Message lengths: 0, 1, 17, 32 and 100 bytes.
- BIP340 authors: Pieter Wuille, Jonas Nick and Tim Ruffing.
- The upstream BIP declares its code under `BSD-2-Clause OR MIT OR CC0-1.0`.
  This fixture is redistributed under the CC0-1.0 option. See the
  [upstream licence declaration](https://github.com/bitcoin/bips/blob/130b8e0fa7f30fa45532f080b87b8db27a79e46e/bip-0340.mediawiki)
  and [CC0-1.0 legal text](https://creativecommons.org/publicdomain/zero/1.0/legalcode).

The loader checks the exact file digest, row count, column layout, expected
results and message lengths before running a circuit.
