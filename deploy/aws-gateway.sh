#!/usr/bin/env bash
# A temporary public HTTPS ingress for Clarity hardware. Default is a local-only plan.
# Never copy the laptop .env, databases, recordings, AWS credentials, or model keys.
set -euo pipefail
umask 077
export AWS_PAGER=""
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.env.aws-gateway-state.json"
TOKEN_FILE="$ROOT/.env.aws-gateway-control"
REGION="${AWS_REGION:-us-east-1}"
COMMAND="${1:-plan}"
APPLY="${2:-}"
AMI_PARAMETER=/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id

fail() { printf '%s\n' "$*" >&2; exit 1; }
aws_cmd() { command aws --region "$REGION" --output json "$@"; }
field() {
  python3 - "$STATE" "$1" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
v = json.loads(p.read_text()).get(sys.argv[2], '') if p.exists() else ''
print(v if v is not None else '')
PY
}
remember() {
  python3 - "$STATE" "$@" <<'PY'
import json, os, pathlib, sys
p = pathlib.Path(sys.argv[1]); data = json.loads(p.read_text()) if p.exists() else {}
for k, v in zip(sys.argv[2::2], sys.argv[3::2]): data[k] = v
q = p.with_name(p.name + '.tmp'); q.write_text(json.dumps(data, indent=2) + '\n')
os.chmod(q, 0o600); q.replace(p)
PY
}
json_field() { python3 -c "import json,sys; v=json.load(sys.stdin); print($1)"; }
plan() {
  cat <<EOF
LOCAL PREVIEW ONLY — no AWS calls or changes.
Region: $REGION; Ubuntu 24.04; one t3.small with standard CPU credits.
Create: a dedicated security group (public TCP 80/443 only), one public EC2
instance, encrypted 8 GiB gp3 disk deleted on termination, and a temporary
private S3 source-upload bucket. No SSH, IAM role, Elastic IP, or paid AI calls.
Use the default VPC/subnet; abort if there is none. HTTPS uses the instance's
public-IP.sslip.io name and Caddy. DNS/certificate issuance must succeed.
Egress is shaped to 5 Mbit/s; data-transfer fees can still accrue.
Runtime: remote ingestion, no synthetic peers, no USB, no model keys, no Tiger
connection. Read-only dashboards are public; writes require a generated token.
The source archive permits only gateway Python/JSON/TXT and built web files;
laptop .env files, DBs, logs, git data, dependencies and symlinks are excluded.
Token: .env.aws-gateway-control (private, git-ignored, never printed).
State: .env.aws-gateway-state.json (private, git-ignored).
Shutdown: an early 24-hour poweroff timer plus terminate-on-OS-shutdown; this
is a best-effort lifetime limit, not a guaranteed AWS dollar billing cap.
S3 upload is deleted after readiness; one-day expiry is a fallback. The empty
bucket and security group are removed by down --apply. EC2 data is temporary.
Execution requires an authenticated AWS CLI and an approved account/deployment:
  AWS_EXPECTED_ACCOUNT_ID='YOUR_APPROVED_12_DIGIT_ACCOUNT' deploy/aws-gateway.sh up --apply
Cleanup (deletes this deployment's remote database together with the instance):
  deploy/aws-gateway.sh down --apply
Status is also guarded and read-only: deploy/aws-gateway.sh status --apply
EOF
}

require_apply() {
  [ "$APPLY" = --apply ] || fail "No AWS action taken. Review plan, then use $COMMAND --apply."
  command -v aws >/dev/null || fail 'AWS CLI is required.'
  command -v python3 >/dev/null || fail 'Python 3 is required.'
  if [ -f "$STATE" ]; then
    local saved; saved=$(field region)
    [ -z "$saved" ] || REGION="$saved"
  fi
  local expected="${AWS_EXPECTED_ACCOUNT_ID:-}"
  [[ "$expected" =~ ^[0-9]{12}$ ]] || fail 'Set AWS_EXPECTED_ACCOUNT_ID to the specifically approved 12-digit AWS account. No AWS changes made.'
  # Verify the approved account without printing account details or credentials.
  local actual saved_account
  actual=$(aws_cmd sts get-caller-identity --query Account | json_field 'v')
  [ "$actual" = "$expected" ] || fail 'AWS login does not match the specifically approved account. No AWS changes made.'
  saved_account=$(field account)
  [ -z "$saved_account" ] || [ "$saved_account" = "$expected" ] || fail 'Local state belongs to a different AWS account; refusing to touch it.'
  remember account "$expected"
}

status() {
  local id; id=$(field instance_id)
  [ -n "$id" ] || { echo 'No instance recorded in local deployment state.'; return; }
  local state; state=$(aws_cmd ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].State.Name' | json_field 'v')
  printf 'Instance: %s\nState: %s\n' "$id" "$state"
  local url; url=$(field url)
  [ -z "$url" ] || printf 'HTTPS endpoint: %s\n' "$url"
}

up() {
  command -v curl >/dev/null || fail 'curl is required.'
  WORK=$(mktemp -d)
  local work="$WORK"
  trap 'rm -rf "$WORK"' EXIT
  local deployment; deployment=$(field deployment)
  if [ -z "$deployment" ]; then
    deployment=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
    remember deployment "$deployment" region "$REGION"
  fi
  local name="clarity-gateway-${deployment:0:12}"
  local id; id=$(field instance_id)
  if [ -z "$id" ]; then
    id=$(aws_cmd ec2 describe-instances --filters "Name=tag:Name,Values=$name" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' | json_field 'v or ""')
    [ -z "$id" ] || remember instance_id "$id"
  fi
  if [ -n "$id" ]; then
    echo 'This deployment already has a recorded instance; no duplicate created.'
    status
    return
  fi
  # All gateway source and static assets are read from local disk. Do not use git
  # archive: uncommitted fixes are intentionally included, but secrets never are.
  if [ ! -f "$TOKEN_FILE" ]; then
    python3 - "$TOKEN_FILE" <<'PY'
import os, pathlib, secrets, sys
p = pathlib.Path(sys.argv[1]); p.write_text('CONTROL_TOKEN=' + secrets.token_hex(32) + '\n'); os.chmod(p, 0o600)
PY
  fi
  python3 - "$ROOT" "$TOKEN_FILE" "$work/source.tar.gz" <<'PY'
import io, pathlib, re, sys, tarfile
root, token_path, output = map(pathlib.Path, sys.argv[1:])
token = token_path.read_text().strip()
if not re.fullmatch(r'CONTROL_TOKEN=[0-9a-f]{64}', token): raise SystemExit('Invalid local control-token file; refusing to deploy.')
required = root / 'gateway' / 'gateway.py'
if 'GATEWAY_MODE' not in required.read_text() or '/api/ingest' not in required.read_text():
    raise SystemExit('Remote-ingest gateway implementation is missing; refusing to deploy.')
env = ('GATEWAY_MODE=remote\nREMOTE_INGEST=1\nMOCK=0\nSIM_NODES=0\nBASELINE_DAYS=0\n'
       'RECORD=0\nINVESTIGATOR=0\nAI_PROVIDER=\nGOOGLE_API_KEY=\nGEMINI_API_KEY=\n'
       'ANTHROPIC_API_KEY=\nTIGER_DATABASE_URL=\nDATABASE_URL=\n'
       'DB_PATH=/var/lib/clarity/gateway.db\n' + token + '\n')
with tarfile.open(output, 'w:gz') as tar:
    for folder in ('gateway', 'web'):
        for p in sorted((root / folder).rglob('*')):
            rel = p.relative_to(root); parts = rel.parts
            if any(x in p.name.lower() for x in ('secret', 'credential', 'private', 'token')): continue
            if p.is_symlink() or not p.is_file(): continue
            if any(x.startswith('.') or x in {'node_modules', '__pycache__', 'logs', 'api'} for x in parts): continue
            if folder == 'gateway':
                if len(parts) != 2 or p.name.startswith('test_'): continue
                if p.suffix == '.json' and p.name not in {'network.json', 'reference.json', 'guidance.json', 'guidance_index.json'}: continue
                if p.suffix == '.txt' and p.name not in {'requirements.txt', 'requirements.lock.txt'}: continue
                if p.suffix not in {'.py', '.json', '.txt'}: continue
            elif p.suffix.lower() not in {'.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico', '.txt', '.woff', '.woff2'}:
                continue
            tar.add(p, arcname=str(rel), recursive=False)
    b = env.encode(); info = tarfile.TarInfo('runtime.env'); info.size = len(b); info.mode = 0o600; tar.addfile(info, io.BytesIO(b))
PY
  local vpc subnet ami sg bucket
  vpc=$(aws_cmd ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' | json_field 'v or ""')
  [ -n "$vpc" ] || fail 'No default VPC exists; no network was created.'
  subnet=$(aws_cmd ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc" Name=default-for-az,Values=true Name=state,Values=available --query 'Subnets[0].SubnetId' | json_field 'v or ""')
  [ -n "$subnet" ] || fail 'No default subnet exists; no network was created.'
  ami=$(aws_cmd ssm get-parameter --name "$AMI_PARAMETER" --query Parameter.Value | json_field 'v')
  bucket=$(field bucket)
  if [ -z "$bucket" ]; then
    bucket="clarity-source-$deployment"
    # Record names before writes so partial failures still have a cleanup path.
    remember bucket "$bucket" group_name "$name" vpc "$vpc"
  fi
  if ! aws_cmd s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    if [ "$REGION" = us-east-1 ]; then
      aws_cmd s3api create-bucket --bucket "$bucket" >/dev/null
    else
      aws_cmd s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
    fi
  fi
  aws_cmd s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
  aws_cmd s3api put-bucket-lifecycle-configuration --bucket "$bucket" --lifecycle-configuration '{"Rules":[{"ID":"expire-bootstrap","Status":"Enabled","Filter":{"Prefix":"bootstrap/"},"Expiration":{"Days":1},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}' >/dev/null
  aws_cmd s3 cp "$work/source.tar.gz" "s3://$bucket/bootstrap/source.tar.gz" --sse AES256 --only-show-errors >/dev/null
  # A presigned URL is a bearer credential. Capture it to a file, never stdout/logs.
  aws_cmd s3 presign "s3://$bucket/bootstrap/source.tar.gz" --expires-in 3600 > "$work/download-url"
  sg=$(field security_group)
  if [ -z "$sg" ]; then
    sg=$(aws_cmd ec2 describe-security-groups --filters "Name=group-name,Values=$name" "Name=vpc-id,Values=$vpc" --query 'SecurityGroups[0].GroupId' | json_field 'v or ""')
    if [ -z "$sg" ]; then
      sg=$(aws_cmd ec2 create-security-group --group-name "$name" --description 'Temporary Clarity HTTPS hardware ingress; no SSH' --vpc-id "$vpc" --query GroupId | json_field 'v')
    fi
    remember security_group "$sg"
  fi
  # Reapplying does not duplicate ingress; only this deployment's group is touched.
  local permissions='[{"IpProtocol":"tcp","FromPort":80,"ToPort":80,"IpRanges":[{"CidrIp":"0.0.0.0/0"}]},{"IpProtocol":"tcp","FromPort":443,"ToPort":443,"IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]'
  local ingress; ingress=$(aws_cmd ec2 describe-security-groups --group-ids "$sg" --query 'SecurityGroups[0].IpPermissions')
  if [ "$ingress" = '[]' ]; then
    aws_cmd ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions "$permissions" >/dev/null
  fi
  cat > "$work/user-data" <<'BOOT'
#!/bin/bash
set -euo pipefail
umask 077
# Arm expiry BEFORE downloading packages; even an installation failure must expire.
cat > /etc/systemd/system/clarity-expiry.service <<'UNIT'
[Unit]
Description=Terminate the temporary Clarity host
[Service]
Type=oneshot
ExecStart=/sbin/poweroff
UNIT
cat > /etc/systemd/system/clarity-expiry.timer <<'UNIT'
[Unit]
Description=24-hour maximum intended lifetime for Clarity
[Timer]
OnCalendar=EXPIRY_UTC
Persistent=true
AccuracySec=1min
Unit=clarity-expiry.service
[Install]
WantedBy=timers.target
UNIT
expiry=$(date -u -d '+24 hours' '+%Y-%m-%d %H:%M:%S UTC')
sed -i "s/EXPIRY_UTC/$expiry/" /etc/systemd/system/clarity-expiry.timer
systemctl daemon-reload
systemctl enable --now clarity-expiry.timer
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip caddy curl ca-certificates iproute2
cat > /usr/local/sbin/clarity-egress <<'SHAPER'
#!/bin/sh
set -eu
dev=$(ip -o route show default | awk 'NR==1{print $5}')
[ -n "$dev" ]
tc qdisc replace dev "$dev" root tbf rate 5mbit burst 64kb latency 400ms
SHAPER
chmod 0755 /usr/local/sbin/clarity-egress
cat > /etc/systemd/system/clarity-egress.service <<'UNIT'
[Unit]
Description=Limit temporary Clarity public egress to 5 Mbit/s
After=network-online.target
Wants=network-online.target
Before=clarity-gateway.service caddy.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/clarity-egress
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now clarity-egress
useradd --system --home /opt/clarity --shell /usr/sbin/nologin clarity || true
install -d -m 0755 /opt/clarity
install -d -o clarity -g clarity -m 0700 /var/lib/clarity
# The signed URL is appended as a private curl config by the launcher below.
BOOT
  python3 - "$work/download-url" "$work/user-data" <<'PY'
import pathlib, sys
url = pathlib.Path(sys.argv[1]).read_text().strip()
if not url.startswith('https://') or any(c in url for c in '\n\r"\\'): raise SystemExit('Unexpected signed URL format')
with pathlib.Path(sys.argv[2]).open('a') as f:
    f.write("cat > /root/clarity-download.conf <<'DOWNLOAD'\nurl = \"" + url + "\"\noutput = \"/root/clarity-source.tar.gz\"\nDOWNLOAD\n")
PY
  cat >> "$work/user-data" <<'BOOT'
curl --fail --silent --show-error --retry 3 --connect-timeout 15 --max-time 180 --config /root/clarity-download.conf
tar --extract --gzip --file /root/clarity-source.tar.gz --directory /opt/clarity --no-same-owner
rm -f /root/clarity-download.conf /root/clarity-source.tar.gz
install -o root -g clarity -m 0640 /opt/clarity/runtime.env /etc/clarity-gateway.env
rm -f /opt/clarity/runtime.env
python3 -m venv /opt/clarity/venv
/opt/clarity/venv/bin/pip --quiet install 'fastapi==0.162.7' 'uvicorn==0.54.0' 'pyserial==3.5' 'python-dotenv==1.2.4' 'psycopg[binary]==3.3.9' 'websockets==17.4'
chown -R root:root /opt/clarity
chmod -R a+rX /opt/clarity
cat > /etc/systemd/system/clarity-gateway.service <<'UNIT'
[Unit]
Description=Clarity hardware HTTPS ingress
After=network-online.target clarity-egress.service
Wants=network-online.target
Requires=clarity-egress.service
[Service]
User=clarity
Group=clarity
WorkingDirectory=/opt/clarity/gateway
EnvironmentFile=/etc/clarity-gateway.env
ExecStart=/opt/clarity/venv/bin/uvicorn gateway:app --host 127.0.0.1 --port 8000 --no-proxy-headers
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/clarity
[Install]
WantedBy=multi-user.target
UNIT
# IMDSv2 gives this instance's ephemeral public IP; no IAM role is needed.
meta=$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
ip=$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 -H "X-aws-ec2-metadata-token: $meta" http://169.254.169.254/latest/meta-data/public-ipv4)
[[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
host="${ip//./-}.sslip.io"
cat > /etc/caddy/Caddyfile <<CADDY
$host {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8000
}
CADDY
systemctl daemon-reload
systemctl enable --now clarity-gateway
systemctl enable caddy
systemctl restart caddy
BOOT
  bash -n "$work/user-data"
  [ "$(wc -c < "$work/user-data")" -le 16384 ] || fail 'EC2 user-data limit exceeded; nothing launched.'
  id=$(aws_cmd ec2 run-instances --client-token "$deployment" --image-id "$ami" --instance-type t3.small --credit-specification CpuCredits=standard --min-count 1 --max-count 1 --instance-initiated-shutdown-behavior terminate --metadata-options HttpTokens=required,HttpEndpoint=enabled --network-interfaces "DeviceIndex=0,SubnetId=$subnet,Groups=$sg,AssociatePublicIpAddress=true,DeleteOnTermination=true" --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=8,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$name},{Key=Purpose,Value=clarity-temporary-gateway}]" "ResourceType=volume,Tags=[{Key=Name,Value=$name}]" --user-data "file://$work/user-data" --query 'Instances[0].InstanceId' | json_field 'v')
  remember instance_id "$id"
  echo 'Instance launched; waiting for startup and valid HTTPS (up to 12 minutes).'
  aws_cmd ec2 wait instance-running --instance-ids "$id"
  local ip host url
  ip=$(aws_cmd ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].PublicIpAddress' | json_field 'v or ""')
  [ -n "$ip" ] || fail 'No public IP was assigned; use down --apply to remove this deployment.'
  host="${ip//./-}.sslip.io"; url="https://$host"
  remember url "$url" hostname "$host"
  local ready=0
  for ((attempt=0; attempt<144; attempt++)); do
    if curl --fail --silent --connect-timeout 3 --max-time 5 "$url/health" > "$work/health.json" 2>/dev/null && python3 - "$work/health.json" <<'PY'
import json, sys
try:
    h = json.load(open(sys.argv[1]))
    ok = h.get('mock') is False and h.get('remote_ingest') is True and h.get('ingest_ready') is True and h.get('cloud', {}).get('enabled') is False
except (ValueError, OSError, AttributeError): ok = False
raise SystemExit(0 if ok else 1)
PY
    then ready=1; break; fi
    sleep 5
  done
  [ "$ready" = 1 ] || fail 'HTTPS ingress did not become ready. Instance still expires automatically; inspect AWS console or use down --apply. Token was not printed.'
  aws_cmd s3api delete-object --bucket "$bucket" --key bootstrap/source.tar.gz >/dev/null
  aws_cmd s3api delete-bucket --bucket "$bucket" >/dev/null
  remember bucket ""
  printf 'Ready: %s\nHardware endpoint: %s/api/ingest\n' "$url" "$url"
  echo 'Read CONTROL_TOKEN from the private local .env.aws-gateway-control file; never paste it into chat or commit it.'
}

down() {
  local id sg bucket
  id=$(field instance_id); sg=$(field security_group); bucket=$(field bucket)
  if [ -n "$id" ]; then
    aws_cmd ec2 terminate-instances --instance-ids "$id" >/dev/null
    aws_cmd ec2 wait instance-terminated --instance-ids "$id"
  fi
  if [ -n "$bucket" ]; then
    aws_cmd s3api delete-object --bucket "$bucket" --key bootstrap/source.tar.gz >/dev/null
    aws_cmd s3api delete-bucket --bucket "$bucket" >/dev/null
  fi
  if [ -z "$sg" ] && [ -n "$(field group_name)" ]; then
    sg=$(aws_cmd ec2 describe-security-groups --filters "Name=group-name,Values=$(field group_name)" "Name=vpc-id,Values=$(field vpc)" --query 'SecurityGroups[0].GroupId' | json_field 'v or ""')
  fi
  if [ -n "$sg" ]; then aws_cmd ec2 delete-security-group --group-id "$sg" >/dev/null; fi
  # Keep the token private and preserve an audit trail; no local history is erased.
  remember instance_id "" security_group "" bucket "" url "" hostname ""
  echo 'Temporary AWS resources removed. Local token and state files retained privately.'
}

case "$COMMAND" in
  plan) plan ;;
  up|status|down) require_apply; "$COMMAND" ;;
  *) fail 'Usage: deploy/aws-gateway.sh {plan|up|status|down} [--apply]' ;;
esac
