# Account custody: Compact / Minocrab

Release build, one warm-up proof, median of measured samples. Verification is cryptographic proof verification, excluding ledger replay and transaction validation.

Complete funded transaction bytes have not been measured. Proof bytes below must not be interpreted as transaction size.

| Circuit | k C/M | Rows C/M | Prove s C/M | Verify ms C/M | Proof bytes C/M |
|---|---|---|---|---|---|
| withdraw_unshielded_with_grant_k256 | 17/16 | 76862/64162 | 4.780/2.769 | 3.82/4.21 | 6336/6336 |
| activate_initial_device_with_jubjub | 14/14 | 13447/13447 | 0.627/0.635 | 3.07/3.13 | 5744/5744 |
| activate_initial_device_with_k256 | 14/14 | 14129/12778 | 0.695/0.708 | 3.18/3.16 | 6336/6336 |
| activate_initial_device_with_p256 | 14/14 | 15342/14807 | 0.755/0.810 | 3.17/3.29 | 6336/6336 |
| add_device_with_jubjub | 15/15 | 26819/26813 | 1.218/1.196 | 3.46/3.41 | 5744/5744 |
| add_device_with_k256 | 17/16 | 61809/52002 | 4.737/2.500 | 3.51/3.54 | 6336/6336 |
| add_device_with_p256 | 18/17 | 129887/124132 | 9.840/5.370 | 3.36/3.42 | 6336/6336 |
| append_inbox_with_jubjub | 16/16 | 32838/32832 | 2.003/2.016 | 3.13/3.13 | 5744/5744 |
| append_inbox_with_k256 | 17/16 | 67836/58029 | 4.654/2.492 | 3.34/3.42 | 6336/6336 |
| append_inbox_with_p256 | 18/17 | 135914/130159 | 10.676/5.409 | 3.67/3.31 | 6336/6336 |
| deposit_shielded | 13/13 | 6506/6506 | 0.297/0.286 | 2.68/2.74 | 5392/5392 |
| deposit_unshielded | 9/9 | 331/340 | 0.043/0.044 | 2.43/2.43 | 3824/3824 |
| issue_grant_with_jubjub | 16/16 | 59968/59959 | 2.155/2.151 | 3.68/3.76 | 5744/5744 |
| issue_grant_with_k256 | 17/17 | 94960/79423 | 4.746/4.837 | 3.67/3.80 | 6336/6336 |
| issue_grant_with_p256 | 18/18 | 163038/150960 | 9.559/9.398 | 3.69/3.79 | 6336/6336 |
| publish_recovery_session_with_jubjub | 16/16 | 36491/36917 | 2.114/2.094 | 3.62/3.61 | 5744/5744 |
| publish_recovery_session_with_k256 | 17/16 | 72217/62114 | 4.724/2.581 | 3.74/3.69 | 6432/6432 |
| publish_recovery_session_with_p256 | 18/18 | 140296/127922 | 9.640/9.386 | 3.90/3.99 | 6432/6432 |
| recover_cancel_with_jubjub | 15/15 | 27029/27390 | 1.191/1.196 | 3.24/3.31 | 5744/5744 |
| recover_cancel_with_k256 | 17/16 | 62383/52577 | 4.591/2.483 | 3.37/3.58 | 6432/6432 |
| recover_cancel_with_p256 | 18/17 | 130460/124706 | 9.531/5.353 | 3.41/3.44 | 6432/6432 |
| recover_finalise | 12/12 | 2365/2448 | 0.272/0.244 | 3.00/3.00 | 4208/4208 |
| recover_submit | 15/15 | 30436/31295 | 1.450/1.367 | 3.16/3.10 | 5744/5744 |
| remove_device_with_jubjub | 16/16 | 32776/32787 | 2.003/2.044 | 3.30/3.27 | 5744/5744 |
| remove_device_with_k256 | 17/16 | 68314/57718 | 4.598/2.484 | 3.61/3.60 | 6336/6336 |
| remove_device_with_p256 | 18/18 | 138266/125404 | 9.758/9.422 | 3.45/3.37 | 6336/6336 |
| revoke_all_grants_with_jubjub | 15/15 | 26692/26686 | 1.182/1.185 | 3.10/3.12 | 5744/5744 |
| revoke_all_grants_with_k256 | 17/16 | 61682/51875 | 4.534/2.487 | 3.33/3.29 | 6336/6336 |
| revoke_all_grants_with_p256 | 18/17 | 129759/124005 | 9.450/5.249 | 3.37/3.29 | 6336/6336 |
| revoke_grant_with_jubjub | 15/15 | 26922/26916 | 1.134/1.149 | 3.33/3.33 | 5744/5744 |
| revoke_grant_with_k256 | 17/16 | 61912/52105 | 4.488/2.399 | 3.64/3.68 | 6336/6336 |
| revoke_grant_with_p256 | 18/17 | 129990/124235 | 9.328/5.267 | 3.58/3.61 | 6336/6336 |
| rotate_enc_key_with_jubjub | 15/15 | 26764/26758 | 1.132/1.196 | 3.11/3.01 | 5744/5744 |
| rotate_enc_key_with_k256 | 17/16 | 61754/51947 | 4.510/2.394 | 3.15/3.50 | 6336/6336 |
| rotate_enc_key_with_p256 | 18/17 | 129832/124077 | 9.280/5.237 | 3.13/3.28 | 6336/6336 |
| withdraw_shielded_to_contract_with_grant_jubjub | 17/17 | 75617/69978 | 3.918/3.917 | 3.74/3.93 | 5744/5744 |
| withdraw_shielded_to_contract_with_grant_k256 | 17/17 | 110083/85961 | 4.834/4.642 | 3.90/4.06 | 6336/6336 |
| withdraw_shielded_to_contract_with_grant_p256 | 18/18 | 180080/163176 | 9.408/9.237 | 3.89/3.98 | 6336/6336 |
| withdraw_shielded_to_contract_with_jubjub | 16/16 | 55792/50147 | 2.039/2.017 | 3.27/3.15 | 5744/5744 |
| withdraw_shielded_to_contract_with_k256 | 17/17 | 88939/67766 | 4.629/4.426 | 3.27/3.33 | 6336/6336 |
| withdraw_shielded_to_contract_with_p256 | 18/18 | 157018/139303 | 9.022/8.825 | 3.49/3.41 | 6336/6336 |
| withdraw_shielded_with_grant_jubjub | 17/17 | 69914/69913 | 3.785/3.812 | 3.57/3.62 | 5744/5744 |
| withdraw_shielded_with_grant_k256 | 17/17 | 104380/85896 | 4.915/4.520 | 4.04/3.74 | 6336/6336 |
| withdraw_shielded_with_grant_p256 | 18/18 | 174377/163111 | 9.458/9.104 | 3.80/3.94 | 6336/6336 |
| withdraw_shielded_with_jubjub | 16/16 | 50089/50082 | 2.032/2.045 | 3.20/3.18 | 5744/5744 |
| withdraw_shielded_with_k256 | 17/17 | 83236/67701 | 4.604/4.471 | 3.44/3.40 | 6336/6336 |
| withdraw_shielded_with_p256 | 18/18 | 151315/139238 | 9.252/9.011 | 3.31/3.55 | 6336/6336 |
| withdraw_unshielded_with_grant_jubjub | 16/16 | 42406/42457 | 1.992/1.987 | 3.57/3.74 | 5744/5744 |
| withdraw_unshielded_with_grant_p256 | 18/18 | 146859/135645 | 9.233/9.064 | 3.81/3.93 | 6336/6336 |
| withdraw_unshielded_with_jubjub | 15/15 | 28920/28968 | 1.126/1.125 | 3.35/3.51 | 5744/5744 |
| withdraw_unshielded_with_k256 | 17/16 | 63907/54157 | 4.441/2.363 | 3.39/3.58 | 6336/6336 |
| withdraw_unshielded_with_p256 | 18/17 | 131986/126284 | 8.952/5.166 | 3.51/3.59 | 6336/6336 |
