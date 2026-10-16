# Account custody: Compact / Minocrab

Release build, one warm-up proof, median of measured samples. Verification is cryptographic proof verification, excluding ledger replay and transaction validation.

Complete funded transaction bytes have not been measured. Proof bytes below must not be interpreted as transaction size.

| Circuit | k C/M | Rows C/M | Prove s C/M | Verify ms C/M | Proof bytes C/M |
|---|---|---|---|---|---|
| withdraw_unshielded_with_grant_k256 | 17/16 | 64355/60260 | 4.405/2.434 | 3.48/3.71 | 6336/6336 |
| activate_initial_device_with_jubjub | 14/14 | 13412/13412 | 0.581/0.587 | 2.85/2.64 | 5744/5744 |
| activate_initial_device_with_k256 | 14/14 | 14094/12743 | 0.631/0.628 | 2.86/2.96 | 6336/6336 |
| add_device_with_jubjub | 15/15 | 26771/26765 | 1.108/1.103 | 2.93/2.90 | 5744/5744 |
| add_device_with_k256 | 16/16 | 58897/51954 | 2.415/2.355 | 3.14/3.21 | 6336/6336 |
| append_inbox_with_jubjub | 16/16 | 32790/32784 | 1.978/1.963 | 3.09/2.97 | 5744/5744 |
| append_inbox_with_k256 | 16/16 | 64924/57981 | 2.488/2.447 | 3.43/3.41 | 6336/6336 |
| deposit_shielded | 13/13 | 6484/6484 | 0.277/0.276 | 2.66/2.60 | 5392/5392 |
| deposit_unshielded | 9/9 | 311/320 | 0.041/0.039 | 2.34/2.40 | 3824/3824 |
| issue_grant_with_jubjub | 16/16 | 52227/52211 | 2.077/2.084 | 3.46/3.77 | 5744/5744 |
| issue_grant_with_k256 | 17/17 | 78604/71675 | 4.668/4.655 | 3.48/3.66 | 6336/6336 |
| remove_device_with_jubjub | 15/15 | 32730/32741 | 1.159/1.155 | 3.15/3.15 | 5744/5744 |
| remove_device_with_k256 | 16/16 | 65404/57664 | 2.477/2.421 | 3.20/3.35 | 6336/6336 |
| revoke_all_grants_with_jubjub | 15/15 | 26645/26639 | 1.121/1.122 | 2.88/2.99 | 5744/5744 |
| revoke_all_grants_with_k256 | 16/16 | 58771/51828 | 2.440/2.392 | 3.20/3.10 | 6336/6336 |
| revoke_grant_with_jubjub | 15/15 | 26871/26865 | 1.117/1.123 | 3.20/3.20 | 5744/5744 |
| revoke_grant_with_k256 | 16/16 | 58997/52054 | 2.463/2.380 | 3.62/3.38 | 6336/6336 |
| rotate_enc_key_with_jubjub | 15/15 | 26725/26719 | 1.120/1.117 | 2.91/2.89 | 5744/5744 |
| rotate_enc_key_with_k256 | 16/16 | 58851/51908 | 2.426/2.389 | 3.32/3.11 | 6336/6336 |
| withdraw_shielded_to_contract_with_grant_jubjub | 17/17 | 71717/66068 | 3.878/3.868 | 3.41/3.47 | 5744/5744 |
| withdraw_shielded_to_contract_with_grant_k256 | 17/17 | 97568/82051 | 4.699/4.599 | 3.61/3.55 | 6336/6336 |
| withdraw_shielded_to_contract_with_jubjub | 16/16 | 55758/50113 | 2.067/2.062 | 3.13/3.15 | 5744/5744 |
| withdraw_shielded_to_contract_with_k256 | 17/17 | 80290/67732 | 4.600/4.529 | 3.21/3.34 | 6336/6336 |
| withdraw_shielded_with_grant_jubjub | 17/17 | 66014/66003 | 3.824/3.857 | 3.38/3.32 | 5744/5744 |
| withdraw_shielded_with_grant_k256 | 17/17 | 91865/81986 | 4.680/4.690 | 3.57/3.58 | 6336/6336 |
| withdraw_shielded_with_jubjub | 16/16 | 50055/50048 | 2.073/2.071 | 2.97/2.99 | 5744/5744 |
| withdraw_shielded_with_k256 | 17/17 | 74587/67667 | 4.569/4.494 | 3.28/3.21 | 6336/6336 |
| withdraw_unshielded_with_grant_jubjub | 16/16 | 38514/38555 | 1.986/1.974 | 3.34/3.48 | 5744/5744 |
| withdraw_unshielded_with_jubjub | 15/15 | 28877/28925 | 1.127/1.122 | 3.15/3.28 | 5744/5744 |
| withdraw_unshielded_with_k256 | 16/16 | 61003/54114 | 2.417/2.406 | 3.42/3.45 | 6336/6336 |
