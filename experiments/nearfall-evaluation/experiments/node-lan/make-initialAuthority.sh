#!/usr/bin/env bash

LABEL=node-$1

cat << EOI > $LABEL/initialAuthority.json
{
  "Permissioned": {
    "id": "$(sed -n '/Public key (SS58)/{s/^  Public key (SS58): \(.*\)$/\1/;p}' $LABEL/beefy.keygen)"
  , "keys": {
      "aura" : "$(sed -n '/Public key (SS58)/{s/^  Public key (SS58): \(.*\)$/\1/;p}' $LABEL/aura.keygen)"
    , "grandpa" : "$(sed -n '/Public key (SS58)/{s/^  Public key (SS58): \(.*\)$/\1/;p}' $LABEL/grandpa.keygen)"
    }
  }
}
EOI
