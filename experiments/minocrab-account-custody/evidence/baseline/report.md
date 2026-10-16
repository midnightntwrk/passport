# Account custody: Compact / Minocrab

Release build, one warm-up proof, median of measured samples. Verification is cryptographic proof verification, excluding ledger replay and transaction validation.

Complete funded transaction bytes have not been measured. Proof bytes below must not be interpreted as transaction size.

| Circuit | k C/M | Rows C/M | Prove s C/M | Verify ms C/M | Proof bytes C/M |
|---|---|---|---|---|---|
| activate_initial_device_with_jubjub | 14/14 | 13412/13412 | 0.616/0.608 | 2.74/2.86 | 5744/5744 |
| activate_initial_device_with_k256 | 14/14 | 14094/14371 | 0.671/0.666 | 2.90/2.88 | 6336/6336 |
| add_device_with_jubjub | 15/15 | 26771/26765 | 1.119/1.108 | 2.89/2.91 | 5744/5744 |
| add_device_with_k256 | 16/16 | 58897/54396 | 2.412/2.354 | 3.13/3.11 | 6336/6336 |
| append_inbox_with_jubjub | 16/16 | 32790/32784 | 1.945/1.958 | 2.91/3.08 | 5744/5744 |
| append_inbox_with_k256 | 16/16 | 64924/60423 | 2.478/2.458 | 3.31/3.31 | 6336/6336 |
| deposit_shielded | 13/13 | 6484/6484 | 0.277/0.276 | 2.57/2.55 | 5392/5392 |
| deposit_unshielded | 9/9 | 311/320 | 0.040/0.039 | 2.41/2.26 | 3824/3824 |
| issue_grant_with_jubjub | 16/16 | 52227/52211 | 2.085/2.077 | 3.51/3.53 | 5744/5744 |
| issue_grant_with_k256 | 17/17 | 78604/74093 | 4.682/4.672 | 3.45/3.51 | 6336/6336 |
| remove_device_with_jubjub | 15/15 | 32730/32741 | 1.166/1.225 | 3.35/3.23 | 5744/5744 |
| remove_device_with_k256 | 16/16 | 65404/60920 | 2.477/2.451 | 3.56/3.34 | 6336/6336 |
| revoke_all_grants_with_jubjub | 15/15 | 26645/26639 | 1.150/1.135 | 3.00/2.94 | 5744/5744 |
| revoke_all_grants_with_k256 | 16/16 | 58771/54270 | 2.442/2.390 | 3.10/3.17 | 6336/6336 |
| revoke_grant_with_jubjub | 15/15 | 26871/26865 | 1.125/1.125 | 3.30/3.31 | 5744/5744 |
| revoke_grant_with_k256 | 16/16 | 58997/54496 | 2.436/2.385 | 3.75/3.49 | 6336/6336 |
| rotate_enc_key_with_jubjub | 15/15 | 26725/26719 | 1.118/1.193 | 2.94/3.13 | 5744/5744 |
| rotate_enc_key_with_k256 | 16/16 | 58851/54350 | 2.453/2.429 | 3.15/3.25 | 6336/6336 |
| withdraw_shielded_to_contract_with_grant_jubjub | 17/17 | 71717/71711 | 3.896/3.854 | 3.41/3.38 | 5744/5744 |
| withdraw_shielded_to_contract_with_grant_k256 | 17/17 | 97568/93064 | 4.704/4.693 | 3.56/3.70 | 6336/6336 |
| withdraw_shielded_to_contract_with_jubjub | 16/16 | 55758/55756 | 2.096/2.056 | 3.08/3.09 | 5744/5744 |
| withdraw_shielded_to_contract_with_k256 | 17/17 | 80290/75793 | 4.538/4.538 | 3.44/3.22 | 6336/6336 |
| withdraw_shielded_with_grant_jubjub | 17/17 | 66014/71666 | 3.818/3.852 | 3.48/3.42 | 5744/5744 |
| withdraw_shielded_with_grant_k256 | 17/17 | 91865/93019 | 4.611/4.622 | 3.69/3.59 | 6336/6336 |
| withdraw_shielded_with_jubjub | 16/16 | 50055/55711 | 2.026/2.060 | 3.18/3.06 | 5744/5744 |
| withdraw_shielded_with_k256 | 17/17 | 74587/75748 | 4.601/4.502 | 3.26/3.21 | 6336/6336 |
| withdraw_unshielded_with_grant_jubjub | 16/16 | 38514/38555 | 1.973/1.982 | 3.46/3.49 | 5744/5744 |
| withdraw_unshielded_with_grant_k256 | 17/17 | 64355/59898 | 4.453/4.450 | 3.43/3.84 | 6336/6336 |
| withdraw_unshielded_with_jubjub | 15/15 | 28877/28925 | 1.130/1.132 | 3.14/3.25 | 5744/5744 |
| withdraw_unshielded_with_k256 | 16/16 | 61003/56556 | 2.394/2.354 | 3.45/3.45 | 6336/6336 |
