#!/usr/bin/env bash

cat << EOI > res/dev/permissioned-candidates-config.json
{
  "permissioned_candidates_policy_id": "0xe78beca2dc84128a0b91b55b48bf1672a7affa5df25feb625ee398c5",
  "initial_permissioned_candidates": [
    {
      "aura_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-1/aura.keygen)",
      "grandpa_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-1/grandpa.keygen)",
      "sidechain_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-1/beefy.keygen)",
      "beefy_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-1/beefy.keygen)"
    },
    {
      "aura_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-2/aura.keygen)",
      "grandpa_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-2/grandpa.keygen)",
      "sidechain_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-2/beefy.keygen)",
      "beefy_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-2/beefy.keygen)"
    },
    {
      "aura_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-3/aura.keygen)",
      "grandpa_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-3/grandpa.keygen)",
      "sidechain_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-3/beefy.keygen)",
      "beefy_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-3/beefy.keygen)"
    },
    {
      "aura_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-4/aura.keygen)",
      "grandpa_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-4/grandpa.keygen)",
      "sidechain_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-4/beefy.keygen)",
      "beefy_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-4/beefy.keygen)"
    },
    {
      "aura_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-5/aura.keygen)",
      "grandpa_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-5/grandpa.keygen)",
      "sidechain_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-5/beefy.keygen)",
      "beefy_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-5/beefy.keygen)"
    },
    {
      "aura_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-6/aura.keygen)",
      "grandpa_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-6/grandpa.keygen)",
      "sidechain_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-6/beefy.keygen)",
      "beefy_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-6/beefy.keygen)"
    },
    {
      "aura_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-7/aura.keygen)",
      "grandpa_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-7/grandpa.keygen)",
      "sidechain_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-7/beefy.keygen)",
      "beefy_pub_key": "$(sed -n '/Public key (hex)/{s/^  Public key (hex):  \(.*\)$/\1/;p}' node-7/beefy.keygen)"
    }
  ]
}
EOI
