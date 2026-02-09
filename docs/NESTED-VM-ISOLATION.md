# Nested VM Isolation for Secret Proxy

**Concept:** Create "cheap TEE" using nested virtualization + ownership transfer

---

## Architecture

```
Host (controls Multipass)
  └─ Multipass VM (moltyclaw47-vm)
      ├─ Agent (OpenClaw) ← can make HTTP requests
      └─ QEMU Nested VM (secret-proxy-vm) ← agent created, host owns
          ├─ Secret proxy process
          ├─ SQLite database
          ├─ Master key
          └─ Telegram bot
```

---

## Setup Flow

### Phase 1: Agent Creates VM (Automated)

```bash
# Inside Multipass VM, agent runs:

# 1. Create disk image
qemu-img create -f qcow2 secret-proxy.qcow2 10G

# 2. Install OS (Alpine Linux for minimal footprint)
# Download cloud-init ISO
curl -O https://dl-cdn.alpinelinux.org/alpine/v3.19/releases/cloud/nocloud_alpine-3.19.0-x86_64-bios-cloudinit-r0.qcow2

# Copy as base
cp nocloud_alpine-*.qcow2 secret-proxy.qcow2

# 3. Create cloud-init config
cat > user-data.yaml <<EOF
#cloud-config
users:
  - name: proxy
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ssh-ed25519 AAAA... # Temporary key for setup
packages:
  - nodejs
  - npm
runcmd:
  - cd /opt && git clone <proxy-repo>
  - cd /opt/secret-proxy && npm install
  - systemctl enable secret-proxy
  - systemctl start secret-proxy
EOF

# 4. Start nested VM
qemu-system-x86_64 \
  -enable-kvm \
  -m 512M \
  -cpu host \
  -smp 1 \
  -drive file=secret-proxy.qcow2,if=virtio \
  -netdev user,id=net0,hostfwd=tcp::3737-:3737 \
  -device virtio-net,netdev=net0 \
  -monitor unix:/tmp/secret-proxy-monitor.sock,server,nowait \
  -daemonize \
  -pidfile /tmp/secret-proxy.pid

# 5. Wait for boot, install proxy
sleep 30
ssh -p 3737 proxy@localhost "cd /opt/secret-proxy && npm start"

# 6. Verify proxy works
curl http://localhost:3737/health

# 7. Signal ready for host takeover
echo "READY_FOR_TAKEOVER" > /tmp/secret-proxy-ready
```

### Phase 2: Host Takes Ownership

```bash
# On host machine (manually or via script):

# 1. Connect to monitor socket
socat - UNIX-CONNECT:/path/to/multipass/vm/tmp/secret-proxy-monitor.sock

# 2. Save VM state
(qemu) savevm takeover-checkpoint

# 3. Stop VM temporarily
(qemu) stop

# 4. Copy disk image to host-owned location
cp /path/to/multipass/secret-proxy.qcow2 /var/lib/secret-proxy/disk.qcow2
chown root:root /var/lib/secret-proxy/disk.qcow2
chmod 600 /var/lib/secret-proxy/disk.qcow2

# 5. Generate NEW SSH key for proxy VM
ssh-keygen -t ed25519 -f /root/.ssh/secret-proxy-key -N ''

# 6. Inject new key into VM (while stopped)
guestfish -a /var/lib/secret-proxy/disk.qcow2 -i \
  write /home/proxy/.ssh/authorized_keys "$(cat /root/.ssh/secret-proxy-key.pub)"

# 7. Start VM from host-owned location
qemu-system-x86_64 \
  -enable-kvm \
  -m 512M \
  -cpu host \
  -smp 1 \
  -drive file=/var/lib/secret-proxy/disk.qcow2,if=virtio \
  -netdev bridge,id=net0,br=br0 \
  -device virtio-net,netdev=net0 \
  -monitor unix:/var/lib/secret-proxy/monitor.sock,server,nowait \
  -daemonize \
  -pidfile /var/lib/secret-proxy/proxy.pid

# 8. Remove agent's access
rm -f /path/to/multipass/tmp/secret-proxy-monitor.sock
rm -f /path/to/multipass/tmp/secret-proxy-ready

# 9. Test from Multipass VM
# Agent can still HTTP request it:
multipass exec moltyclaw47-vm -- curl http://10.x.x.y:3737/health
```

---

## Security Properties

### What Agent CAN Do

✅ Make HTTP requests to proxy  
✅ Request secrets (creates pending approval)  
✅ Poll for approval status  
✅ Retrieve approved secrets  

### What Agent CANNOT Do

❌ Access VM's disk image (host-owned, outside VM)  
❌ Access monitor socket (host-owned)  
❌ SSH into proxy VM (host changed keys)  
❌ Read proxy's memory (would need monitor access)  
❌ Read SQLite database directly  
❌ Access master key  
❌ Send Telegram messages (proxy does this)  

### Attack Scenarios

| Attack | Agent's Capability | Blocked By |
|--------|-------------------|------------|
| Read secrets.db | Would need disk access | Host owns disk image |
| Steal master key | Would need filesystem access | Host owns VM |
| Self-approve requests | Would need to impersonate Telegram | Proxy validates bot token |
| Crash proxy | Could DOS via HTTP flood | Rate limiting + restart |
| Access monitor socket | Would need file access | Host moved socket outside VM |

---

## Advantages vs Standard Docker

| Property | Docker on Host | Nested VM |
|----------|---------------|-----------|
| Agent can access DB | ❌ Yes (volume mount) | ✅ No (separate VM) |
| Agent can see environment | ❌ Yes (docker inspect) | ✅ No (separate memory space) |
| Overhead | ~100MB RAM | ~512MB RAM |
| Startup time | ~1 second | ~10 seconds |
| Complexity | Low | Medium |

---

## Advantages vs Real TEE

| Property | Nested VM | Intel TDX / AMD SEV |
|----------|-----------|---------------------|
| Requires special hardware | ✅ No | ❌ Yes |
| Encrypted memory | ❌ No | ✅ Yes |
| Attestation | ❌ No | ✅ Yes |
| Protection from host | ❌ No | ✅ Yes |
| Protection from agent | ✅ Yes | ✅ Yes |
| Setup complexity | Medium | High |

---

## Implementation Checklist

### Agent Side (Automated)

- [ ] Check for /dev/kvm access
- [ ] Download Alpine cloud image
- [ ] Create cloud-init config with proxy setup
- [ ] Start nested VM with QEMU
- [ ] Wait for proxy to be ready
- [ ] Test HTTP API works
- [ ] Signal ready for takeover

### Host Side (Manual or Script)

- [ ] Receive takeover signal
- [ ] Connect to monitor socket
- [ ] Save VM state
- [ ] Copy disk image to host location
- [ ] Generate new SSH keys
- [ ] Inject keys into VM (guestfish)
- [ ] Restart VM from host location
- [ ] Remove agent's access to monitor/disk
- [ ] Verify agent can still HTTP request
- [ ] Test full approval workflow

---

## Alternative: Container in Nested VM

Simpler hybrid approach:

```bash
# Nested VM runs Docker
# Proxy runs in container inside nested VM
# Host owns VM, agent can't access container

nested-vm:
  - Docker daemon
  - docker run secret-proxy
  - Agent: HTTP → VM → Container → Response
```

**Advantage:** Easier to deploy/update proxy (just docker pull)

---

## Cost Analysis

**Resources:**
- RAM: 512MB for nested VM
- Disk: 10GB (Alpine + proxy ~2GB actual)
- CPU: Minimal (mostly idle)
- Network: Negligible

**Tradeoff:** 512MB RAM for cryptographically-bounded isolation without special hardware.

**Worth it?** If you want isolation stronger than "trust the agent" but don't have TEE hardware, yes.

---

## Next Steps

1. Build proxy as standalone package
2. Test in regular Docker first
3. Create nested VM deployment script
4. Test ownership transfer procedure
5. Document full workflow

