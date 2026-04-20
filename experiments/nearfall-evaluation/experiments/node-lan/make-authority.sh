#!/usr/bin/env bash

LABEL=node-$1

cat << EOI > $LABEL/authority.json
"$(sed -n '/Public key (SS58)/{s/^  Public key (SS58): \(.*\)$/\1/;p}' $LABEL/beefy.keygen)"
EOI

