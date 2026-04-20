import React, {useState, useEffect} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';
import type {ComplianceSyncState} from '../hooks/useCompliance.js';
import type {KycInput} from '../tee/stub-tee.js';
import TxStatus from '../components/TxStatus.js';
import {TIER_LABELS} from '../types.js';

// ---------------------------------------------------------------------------
// Update screen — submit KYC data for TEE evaluation and update on-chain tier.
//
// The stub TEE evaluates the KYC fields and derives:
//   - A compliance tier (0–3) from completeness of the data
//   - An identity_commitment = SHA-256(name|dob|jurisdiction) — stored PRIVATE
//
// The circuit then:
//   1. Verifies the TEE device key: ecMulGenerator(sk_device) == device_pk
//   2. Writes new_tier to PUBLIC ledger state (on-chain)
//   3. Writes identity_commitment to PRIVATE ledger state (LevelDB only)
// ---------------------------------------------------------------------------

type Field = 'name' | 'dob' | 'jurisdiction';
type Step  = 'form' | 'confirm' | 'updating' | 'done';

interface Props {
  compliance: ComplianceSyncState;
  onComplete: () => void;
}

export default function Update({compliance, onComplete}: Props) {
  const [step,         setStep]         = useState<Step>('form');
  const [activeField,  setActiveField]  = useState<Field>('name');
  const [fullName,     setFullName]     = useState('');
  const [dateOfBirth,  setDateOfBirth]  = useState('');
  const [jurisdiction, setJurisdiction] = useState('');

  const {updateTxStatus, update, onChain, walletReady, contractAddress} = compliance;

  const fields: {key: Field; label: string; value: string; set: (v: string) => void; hint: string}[] = [
    {key: 'name',         label: 'Full name',         value: fullName,     set: setFullName,     hint: 'e.g. Jane Doe'},
    {key: 'dob',          label: 'Date of birth',     value: dateOfBirth,  set: setDateOfBirth,  hint: 'YYYY-MM-DD'},
    {key: 'jurisdiction', label: 'Jurisdiction (ISO)', value: jurisdiction, set: setJurisdiction, hint: 'e.g. GBR'},
  ];

  const previewTier = (() => {
    let t = 0;
    if (fullName.trim().length > 0)                             t = 1;
    if (dateOfBirth.match(/^\d{4}-\d{2}-\d{2}$/))               t = 2;
    if (jurisdiction.match(/^[A-Z]{3}$/) && t >= 2)            t = 3;
    return t;
  })();

  useEffect(() => {
    if (step !== 'updating') return;
    if (updateTxStatus.stage === 'confirmed') setStep('done');
  }, [updateTxStatus, step]);

  useInput((_input, key) => {
    if (step === 'form') {
      if (key.tab || key.downArrow) {
        setActiveField(f => f === 'name' ? 'dob' : f === 'dob' ? 'jurisdiction' : 'name');
      }
      if (key.upArrow) {
        setActiveField(f => f === 'jurisdiction' ? 'dob' : f === 'dob' ? 'name' : 'jurisdiction');
      }
    }
    if (step === 'confirm') {
      if (key.return) {
        const input: KycInput = {
          fullName:         fullName.trim(),
          dateOfBirth:      dateOfBirth.trim(),
          jurisdictionCode: jurisdiction.trim(),
        };
        setStep('updating');
        void update(input);
      }
      if (key.escape) setStep('form');
    }
    if (step === 'done') {
      if (key.return || key.escape) onComplete();
    }
    if (step === 'updating' && updateTxStatus.stage === 'failed') {
      if (key.escape) setStep('form');
    }
  }, {isActive: step !== 'form'});

  if (!contractAddress) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="red">No contract connected.</Text>
        <Text dimColor>Go to Setup first.</Text>
      </Box>
    );
  }

  if (!walletReady) {
    return <Text dimColor>Waiting for wallet sync…</Text>;
  }

  if (!onChain?.deviceRegistered) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="yellow">Device not registered.</Text>
        <Text dimColor>Go to Register screen first.</Text>
      </Box>
    );
  }

  if (step === 'form') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Submit KYC Data</Text>
        <Text dimColor>
          The stub TEE will derive a compliance tier and identity commitment.
          Press Tab/↑↓ to move between fields.  Fill in all three for tier 3.
        </Text>
        {fields.map(({key, label, value, set, hint}) => (
          <Box key={key} gap={1}>
            <Text
              color={activeField === key ? 'cyan' : undefined}
              dimColor={activeField !== key}
              bold={activeField === key}
            >
              {label.padEnd(20)}
            </Text>
            {activeField === key ? (
              <TextInput
                value={value}
                onChange={set}
                onSubmit={() => {
                  if (key === 'jurisdiction') setStep('confirm');
                  else setActiveField(f => f === 'name' ? 'dob' : 'jurisdiction');
                }}
                placeholder={hint}
              />
            ) : (
              <Text>{value || <Text dimColor>{hint}</Text>}</Text>
            )}
          </Box>
        ))}
        <Box marginTop={1} gap={2}>
          <Text dimColor>Predicted tier:</Text>
          <Text color={['red','yellow','cyan','green'][previewTier]}>
            {previewTier} — {TIER_LABELS[previewTier as 0|1|2|3]}
          </Text>
        </Box>
        <Text dimColor>Complete all fields and press Enter on Jurisdiction to proceed.</Text>
      </Box>
    );
  }

  if (step === 'confirm') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Confirm KYC Update</Text>
        <Box flexDirection="column">
          <Box gap={2}><Text dimColor>Full name:   </Text><Text>{fullName}</Text></Box>
          <Box gap={2}><Text dimColor>Date of birth:</Text><Text>{dateOfBirth}</Text></Box>
          <Box gap={2}><Text dimColor>Jurisdiction: </Text><Text>{jurisdiction}</Text></Box>
        </Box>
        <Box gap={2} marginTop={1}>
          <Text dimColor>Tier:</Text>
          <Text color={['red','yellow','cyan','green'][previewTier]} bold>
            {previewTier} — {TIER_LABELS[previewTier as 0|1|2|3]}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            The identity commitment (name|dob|jurisdiction hash) will be stored PRIVATELY
            in LevelDB — never on-chain.  The tier will be stored publicly on-chain.
          </Text>
        </Box>
        <Text dimColor>Press Enter to proceed, Esc to edit.</Text>
      </Box>
    );
  }

  if (step === 'updating') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Updating compliance…</Text>
        <TxStatus status={updateTxStatus} label="Update" />
        {updateTxStatus.stage === 'failed' && (
          <Text dimColor>Press Esc to go back.</Text>
        )}
      </Box>
    );
  }

  // done
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="green">✓ Compliance updated.</Text>
      <Box gap={2}>
        <Text dimColor>New tier:</Text>
        <Text color={['red','yellow','cyan','green'][previewTier]} bold>
          {previewTier} — {TIER_LABELS[previewTier as 0|1|2|3]}
        </Text>
      </Box>
      <TxStatus status={updateTxStatus} />
      <Text dimColor>Press Enter to go to Dashboard.</Text>
    </Box>
  );
}
