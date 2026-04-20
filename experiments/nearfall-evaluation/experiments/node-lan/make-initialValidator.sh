#!/usr/bin/env bash

LABEL=node-$1

cat << EOI > $LABEL/initialValidator.json
[
  "$(sed -n '/SS58 Address/{s/^  SS58 Address:      \(.*\)$/\1/;p}' $LABEL/account.keygen)"
, {
    "aura" : "$(sed -n '/Public key (SS58)/{s/^  Public key (SS58): \(.*\)$/\1/;p}' $LABEL/aura.keygen)"
  , "grandpa" : "$(sed -n '/Public key (SS58)/{s/^  Public key (SS58): \(.*\)$/\1/;p}' $LABEL/grandpa.keygen)"
  }
]
EOI

