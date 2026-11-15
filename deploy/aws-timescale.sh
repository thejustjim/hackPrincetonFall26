#!/usr/bin/env bash
# One small EC2 server running TimescaleDB, for Clarity's cloud copy (gateway/cloud.py).
#
#   deploy/aws-timescale.sh up       create it, wait until the database answers, write TIGER_DATABASE_URL into .env
#   deploy/aws-timescale.sh status   what exists, and whether the database answers
#   deploy/aws-timescale.sh down     delete everything this script made (server, address, firewall rule)
#
# Needs the AWS CLI, signed in (`aws login` or `aws configure`). Costs about 3 cents an hour:
# a t3.small, 20 GB of disk and one public address. `down` stops the charges.
#
# What it makes, all tagged Name=clarity-timescale in your default network:
#   - a security group that lets port 5432 (Postgres) in, and nothing else. There is no SSH.
#   - one Amazon Linux server that runs the timescale/timescaledb container with TLS on
#   - an Elastic IP, so the address survives a stop and start
# The database password is random, is never printed, and goes only into .env (git-ignored)
# and the server's own start-up script.
#
# Options (environment variables):
#   AWS_REGION      default: your CLI's region, else us-east-1
#   INSTANCE_TYPE   default: t3.small
#   ALLOW_CIDR      who may reach port 5432. Default 0.0.0.0/0 (anyone, so the Pi works from any
#                   network; the password and TLS are the protection). To allow one address only:
#                   ALLOW_CIDR=$(curl -s https://checkip.amazonaws.com)/32
set -euo pipefail

NAME=clarity-timescale
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
REGION="${REGION:-us-east-1}"
TYPE="${INSTANCE_TYPE:-t3.small}"
ALLOW="${ALLOW_CIDR:-0.0.0.0/0}"
aws() { command aws --region "$REGION" --output text "$@"; }

instance_id() {
  aws ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[0].InstanceId' | head -1 | grep -v '^None$' || true
}
group_id() {
  aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" --query 'SecurityGroups[0].GroupId' | grep -v '^None$' || true
}
address() {   # allocation id and public address of our Elastic IP
  aws ec2 describe-addresses --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].[AllocationId,PublicIp]' | grep -v '^None' || true
}
answers() {   # does the database port answer?
  python3 - "$1" <<'PY'
import socket, sys
try:
    socket.create_connection((sys.argv[1], 5432), timeout=4).close()
except OSError:
    sys.exit(1)
PY
}

up() {
  aws sts get-caller-identity --query Account >/dev/null || { echo "Not signed in to AWS. Run: aws login   (or: aws configure)"; exit 1; }
  if [ -n "$(instance_id)" ]; then echo "It already exists."; status; return; fi
  echo "Creating $NAME in $REGION ($TYPE). Port 5432 open to $ALLOW."

  local vpc sg ami pass data id alloc ip
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId')
  [ "$vpc" != "None" ] || { echo "This region has no default network (VPC). Pick another with AWS_REGION=..."; exit 1; }
  sg=$(group_id)
  if [ -z "$sg" ]; then
    sg=$(aws ec2 create-security-group --group-name "$NAME" --description "Clarity cloud copy: Postgres only" --vpc-id "$vpc" \
          --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$NAME}]" --query GroupId)
    aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 5432 --cidr "$ALLOW" >/dev/null
  fi
  ami=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value)
  pass=$(openssl rand -hex 24)

  data=$(mktemp)
  trap 'rm -f "$data"' RETURN
  cat > "$data" <<BOOT
#!/bin/bash
set -eux
dnf install -y docker openssl
systemctl enable --now docker
mkdir -p /opt/clarity/certs /opt/clarity/data
openssl req -new -x509 -days 60 -nodes -subj "/CN=$NAME" -keyout /opt/clarity/certs/server.key -out /opt/clarity/certs/server.crt
chown -R 70:70 /opt/clarity/certs      # the postgres user inside the image
chmod 600 /opt/clarity/certs/server.key
docker run -d --name timescaledb --restart unless-stopped -p 5432:5432 \\
  -e POSTGRES_USER=clarity -e POSTGRES_PASSWORD=$pass -e POSTGRES_DB=clarity \\
  -v /opt/clarity/data:/var/lib/postgresql/data -v /opt/clarity/certs:/certs:ro \\
  timescale/timescaledb:latest-pg17 \\
  postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key -c password_encryption=scram-sha-256
BOOT

  id=$(aws ec2 run-instances --image-id "$ami" --instance-type "$TYPE" --security-group-ids "$sg" \
        --user-data "file://$data" --metadata-options HttpTokens=required \
        --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" "ResourceType=volume,Tags=[{Key=Name,Value=$NAME}]" \
        --query 'Instances[0].InstanceId')
  echo "Server $id is starting."
  aws ec2 wait instance-running --instance-ids "$id"
  alloc=$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query AllocationId)
  aws ec2 associate-address --instance-id "$id" --allocation-id "$alloc" >/dev/null
  ip=$(aws ec2 describe-addresses --allocation-ids "$alloc" --query 'Addresses[0].PublicIp')

  # the connection string goes into .env only; it is never printed
  touch "$ENV_FILE"
  grep -v '^TIGER_DATABASE_URL=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
  echo "TIGER_DATABASE_URL=postgresql://clarity:$pass@$ip:5432/clarity?sslmode=require" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  echo "Address $ip. TIGER_DATABASE_URL is now in .env. Waiting for the database (it installs itself; about two minutes)."

  for _ in $(seq 1 60); do
    if answers "$ip"; then echo "The database answers. Next: cd gateway && python cloud.py check"; return; fi
    sleep 5
  done
  echo "The database has not answered after five minutes. See what it did with:"
  echo "  aws ec2 get-console-output --region $REGION --instance-id $id --latest --output text | tail -40"
  exit 1
}

status() {
  local id ip
  id=$(instance_id)
  [ -n "$id" ] || { echo "Nothing exists in $REGION."; return; }
  ip=$(address | awk '{print $2}')
  echo "Server $id: $(aws ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].State.Name'), address ${ip:-none}, region $REGION"
  if [ -n "$ip" ] && answers "$ip"; then echo "The database answers on port 5432."; else echo "The database does not answer."; fi
  echo "Port 5432 is open to: $(aws ec2 describe-security-groups --group-ids "$(group_id)" --query 'SecurityGroups[0].IpPermissions[].IpRanges[].CidrIp')"
}

down() {
  local id alloc sg
  id=$(instance_id)
  if [ -n "$id" ]; then
    echo "Deleting server $id and its disk (the cloud copy of the readings goes with it; the base station keeps its own)."
    aws ec2 terminate-instances --instance-ids "$id" >/dev/null
    aws ec2 wait instance-terminated --instance-ids "$id"
  fi
  alloc=$(address | awk '{print $1}')
  [ -z "$alloc" ] || aws ec2 release-address --allocation-id "$alloc"
  sg=$(group_id)
  [ -z "$sg" ] || aws ec2 delete-security-group --group-id "$sg" >/dev/null
  echo "Gone. TIGER_DATABASE_URL is still in .env: clear it so the gateway stops trying."
}

case "${1:-}" in
  up) up ;;
  status) status ;;
  down) down ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
