# 🤖👱 Midnight Proof Server on GCP SEV-SNP Confidential VM

**Date:** 2026-04-10
**Result:** ✅ Proof server operational; `update_compliance` circuit proved successfully; AMD SEV-SNP hardware attestation verified

---

## Objective

Test whether the Midnight proof server can run inside a cloud TEE as a step toward
the production design (Tier 3 in the implementation progression in `ReadMe.md`).

---

## TEE Platform Selection

Intel SGX (the platform targeted by Tier 3) is not available on AWS or GCP:

| Platform | TEE type | Notes |
|---|---|---|
| AWS Nitro Enclaves | Hypervisor/software isolation | No hardware root-of-trust; no Intel SGX |
| **GCP Confidential VM (SEV-SNP)** | AMD SEV-SNP | VM-level hardware TEE; chosen for this experiment |
| Azure DCsv3 + Gramine | Intel SGX | Genuine SGX; recommended for production Tier 3 |

GCP SEV-SNP was selected as the most accessible hardware TEE available within the
project's cloud accounts (AWS, GCP, OVHcloud).

---

## Security Properties of AMD SEV-SNP

SEV-SNP protects the VM from the cloud provider and hypervisor, but does **not**
provide process-level isolation within the VM:

| Threat | SEV-SNP | Intel SGX |
|---|---|---|
| Cloud provider / hypervisor reading VM memory | Protected | Protected |
| Compromised guest OS reading process memory | **Not protected** | Protected |
| Other processes in same VM | **Not protected** | Protected |
| Physical DRAM attack | Protected | Protected |
| Attestation granularity | VM image at boot | Per-enclave binary (MRENCLAVE) |

For this experiment the VM was single-tenant and the OS was trusted, so the
weaker isolation model was acceptable. A production deployment handling `sk_device`
would require Intel SGX (or equivalent process-level isolation) per the Tier 3
design.

---

## Commands

### 1. Create the VM

```bash
gcloud compute instances create sev-snp-test-vm \
  --zone=us-central1-a \
  --machine-type=n2d-standard-8 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --maintenance-policy=TERMINATE \
  --confidential-compute-type=SEV_SNP \
  --service-account=brio-gcp@consult-functionally.iam.gserviceaccount.com \
  --boot-disk-size=50GB
```

Note: `--maintenance-policy=TERMINATE` is required for Confidential VMs; live
migration is not supported.

### 2. Verify SEV-SNP is active (sanity check only)

```bash
sudo dmesg | grep -i sev
# Expected output includes:
# Memory Encryption Features active: AMD SEV SEV-ES SEV-SNP
# SEV: SNP running at VMPL0.
# sev-guest sev-guest: Initialized SEV guest driver (using vmpck_id 0)

ls /dev/sev*
# Expected: /dev/sev-guest
# (/dev/sev is the host-side device; its absence inside the VM is correct)
```

**Caveat:** `dmesg` output and the presence of `/dev/sev-guest` only confirm that
the kernel driver is loaded. They are not cryptographic proof of genuine SEV-SNP
hardware. A malicious hypervisor could present a fake device node.

Cryptographic assurance requires requesting and verifying an **attestation report**
signed by the AMD Secure Processor against AMD's certificate chain (AMD Root CA →
AMD SEV CA → Chip Endorsement Key → report signature). The `snpguest` tool
(github.com/virtee/snpguest) was used to perform this verification.

#### Install snpguest

```bash
sudo apt-get install -y build-essential
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source $HOME/.cargo/env
cargo install snpguest

# /dev/sev-guest is root-owned; grant access
sudo chmod o+rw /dev/sev-guest
```

#### Request the attestation report

```bash
snpguest report --random attestation-report.bin request.bin
```

`--random` generates a random 64-byte nonce and writes it to `request.bin`.
The AMD Secure Processor signs the report (including the nonce) and writes it
to `attestation-report.bin`.

#### Fetch AMD certificates and verify

GCP N2D instances use AMD EPYC Milan (3rd Gen); the `milan` argument selects
the correct certificate chain from AMD's Key Distribution Service (KDS).

```bash
mkdir -p ./certs
snpguest fetch ca pem ./certs milan
snpguest fetch vcek pem ./certs attestation-report.bin
```

```bash
snpguest verify certs ./certs
```
```
The AMD ARK was self-signed!
The AMD ASK was signed by the AMD ARK!
The VCEK was signed by the AMD ASK!
```

```bash
snpguest verify attestation ./certs attestation-report.bin
```
```
Reported TCB Boot Loader from certificate matches the attestation report.
Reported TCB TEE from certificate matches the attestation report.
Reported TCB SNP from certificate matches the attestation report.
Reported TCB Microcode from certificate matches the attestation report.
VEK signed the Attestation Report!
```

**What this confirms:**
- The AMD certificate chain is intact: ARK (AMD root) → ASK (AMD signing) → VCEK (this chip's key).
- The VCEK is the genuine endorsement key for this specific physical chip, fetched from AMD's KDS using the chip ID embedded in the attestation report.
- The TCB (Trusted Computing Base) version fields in the VCEK certificate match those in the attestation report — confirming the firmware versions have not been tampered with.
- The attestation report was signed by the VCEK — meaning it was produced by the AMD Secure Processor on this chip, not fabricated in software.

### 3. Extract the proof server binary from the Docker image

The proof server is a Nix-built binary inside `midnightnetwork/proof-server:latest`.

```bash
sudo apt-get install -y docker.io
sudo usermod -aG docker $USER
newgrp docker

docker pull midnightnetwork/proof-server:latest
docker create --name ps midnightnetwork/proof-server:latest

# Locate the binary (path includes the Nix store hash; inspect output to confirm)
docker exec ps find / -name "midnight-proof-server" 2>/dev/null
# Found at: /nix/store/kmllcdr2h9vi2pdgp56lpmbvfsrg33ds-ledger-7.0.0-rc.1/bin/midnight-proof-server

docker cp ps:/nix/store/kmllcdr2h9vi2pdgp56lpmbvfsrg33ds-ledger-7.0.0-rc.1/bin/midnight-proof-server \
  ./midnight-proof-server
docker rm ps
```

### 4. Patch the ELF interpreter

The binary is dynamically linked against the Nix glibc. The ELF interpreter path
is hardcoded to `/nix/store/.../ld-linux-x86-64.so.2`, which does not exist on
Ubuntu. The shared libraries (`libgcc_s`, `libm`, `libc`) all resolve correctly
from standard Ubuntu paths; only the interpreter needs patching.

```bash
sudo apt-get install -y patchelf
sudo patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 ./midnight-proof-server
```

(`sudo` required because `docker cp` sets the file owner to root.)

### 5. Open the firewall

```bash
# Open to all (experiment only):
gcloud compute firewall-rules create allow-proof-server \
  --allow tcp:6300 \
  --source-ranges 0.0.0.0/0

# Or restrict to a single IP:
gcloud compute firewall-rules create allow-proof-server \
  --allow tcp:6300 \
  --source-ranges $(curl -s ifconfig.me)/32
```

### 6. Run the proof server

```bash
./midnight-proof-server
```

The server retrieved its ZK proving keys automatically and began listening on all
interfaces on port 6300. No manual key provisioning was required.

---

## Result

The `update_compliance` circuit from `experiments/local-tee-poc` was proved
successfully against the proof server running on the GCP SEV-SNP VM. No changes
to the contract, the circuit, or the client code were required.

AMD SEV-SNP hardware attestation was verified end-to-end: the attestation report
was signed by the chip's VCEK, the VCEK traces back to AMD's root certificate
authority, and all TCB version fields matched — confirming the VM is running on
genuine AMD SEV-SNP hardware with unmodified firmware.

---

## Appendix: OS Integrity Verification

The attestation performed above proves the VM is running on genuine AMD SEV-SNP
hardware. It does not by itself prove the guest OS was unmodified. Two
complementary mechanisms address this.

### SEV-SNP launch measurement

The attestation report contains a `MEASUREMENT` field — a SHA-384 hash of the
VM's initial memory state at launch (OVMF firmware + kernel + initrd + kernel
command line). Comparing this against the expected value for a known-good image
gives cryptographic proof the VM booted from an unmodified OS.

```bash
snpguest display report attestation-report.bin
# Look for the MEASUREMENT field in the output
```

The difficulty is computing the expected value independently, which requires
knowing the exact firmware and image versions used by GCP for the boot sequence.

### Shielded VM + vTPM (GCP-integrated, easier)

GCP's **Shielded VM** feature adds three capabilities on top of SEV-SNP:

| Feature | What it does |
|---|---|
| Secure Boot | UEFI verifies the bootloader signature before executing it |
| vTPM | Measures each boot stage (firmware → shim → kernel → initrd) into PCR registers |
| Integrity Monitoring | Records a baseline at first boot; alerts if subsequent boots differ |

For GCP's official images (including the Ubuntu 22.04 used here), GCP publishes
reference measurements. Their attestation service verifies that the vTPM PCR
values match the official image, confirming the OS was not tampered with at boot.

To enable, add three flags to the VM creation command:

```bash
gcloud compute instances create sev-snp-test-vm \
  ...
  --confidential-compute-type=SEV_SNP \
  --shielded-secure-boot \
  --shielded-vtpm \
  --shielded-integrity-monitoring
```

Boot integrity can then be verified in the GCP console (Compute Engine → VM →
Shielded VM) or programmatically via the `go-tpm-tools` library.

### What OS integrity verification does not cover

Boot-time measurement answers "did the VM start from a clean image?" It does not
cover post-boot changes — a root process could load a malicious kernel module or
modify a running binary after boot without affecting PCR measurements. Linux IMA
(Integrity Measurement Architecture) extends verification to runtime by measuring
every binary and file as it is executed, but this requires additional setup.

### Sealed image approach: eliminating interactive access

A stronger operational posture combines Shielded VM with a purpose-built OS image:

- Build a custom image with only the proof server and `snpguest` installed.
- Start the proof server as a systemd service so it launches automatically at boot.
- Disable SSH and all remote access except port 6300 (HTTPS only).
- Block all egress except responses to connections initiated on port 6300
  (stateful firewall rules). This prevents a compromised process from
  exfiltrating witnesses or keys to an external host.
- Enable Shielded VM (`--shielded-secure-boot --shielded-vtpm
  --shielded-integrity-monitoring`) so the boot state is attested.

With this configuration, no operator — including the VM owner — can log in and
alter the running system interactively. The Shielded VM boot measurement proves
the VM started from the correct image, and there is no channel through which to
issue subsequent commands. This eliminates the interactive tampering vector
entirely.

**Remaining gap: proof server RCE.** Port 6300 remains open and is the sole
attack surface. If the proof server has a vulnerability allowing arbitrary code
execution, an attacker could potentially escalate to root within the VM and modify
the running OS or read process memory after boot — changes that would not be
captured by the PCR measurements. In practice this is addressed by auditing the
proof server binary; a clean audit reduces this to a trust-the-audit posture
rather than a hardware guarantee. The egress restriction provides a further
backstop: even a compromised process cannot exfiltrate witnesses or keys if all
outbound traffic is blocked. Intel SGX provides the hardware-enforced equivalent
— root on the host cannot read enclave memory regardless of what the code does —
but requires trusting the audit for the enclave code itself in any case.

### Threat coverage summary

| Threat | SEV-SNP | + Shielded VM | + Sealed image, no SSH | + SGX |
|---|---|---|---|---|
| Hypervisor / cloud provider reads VM memory | ✅ | ✅ | ✅ | ✅ |
| VM booted from tampered OS image | ❌ | ✅ | ✅ | ✅ |
| OS tampered interactively (SSH, console) | ❌ | ❌ | ✅ | ✅ |
| RCE via proof server → post-boot OS modification | ❌ | ❌ | ❌ | ✅ |
| RCE via proof server → read process memory | ❌ | ❌ | ❌ | ✅ |

The sealed image approach narrows the residual risk to a single binary (the proof
server) and a single port. This is a reasonable compliance position: the VM can be
cryptographically proven to have started clean, no interactive access exists, and
the only remaining attack vector is a vulnerability in the proof server itself —
the same binary that SGX would also need to trust as enclave code.

---

## Notes

- The Nix store hash in the binary path (`kmllcdr2h9vi2pdgp56lpmbvfsrg33ds`) is
  version-specific and will differ for other releases of `proof-server`.
- The `patchelf` workaround is fragile across glibc versions; a cleaner long-term
  approach is to copy the entire Docker container filesystem and run the binary
  with the bundled Nix libs, or to use `docker run` directly.
- For a production deployment the VM should be locked down further: restrict port
  6300 to known client IPs, disable all other inbound ports, and run the proof
  server as a non-root user.
- This experiment does not validate the full Tier 3 design (Intel SGX + DCAP
  attestation). It confirms that the proof server binary operates correctly on
  x86_64 in a cloud TEE context. Azure DCsv3 + Gramine remains the recommended
  path for genuine process-level isolation.
