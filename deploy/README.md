# Temporary AWS hardware gateway

`aws-gateway.sh` prepares and launches a temporary HTTPS receiver for the hardware team. It serves this repository's current gateway and built website; it includes uncommitted local fixes. This is separate from `aws-timescale.sh`, which provisions a database.

The default command is a **local preview**. It makes no AWS calls:

```sh
deploy/aws-gateway.sh plan
```

After the exact deployment/account and spending have been approved, authenticate the AWS CLI in that account and run:

```sh
AWS_REGION=us-east-1 AWS_EXPECTED_ACCOUNT_ID='YOUR_APPROVED_12_DIGIT_ACCOUNT' deploy/aws-gateway.sh up --apply
```

The script does not authenticate for you or choose an account. Every cloud action requires `AWS_EXPECTED_ACCOUNT_ID` to match the specifically approved account, the current login and any saved deployment state; a mismatch fails before resource changes. Set it in your terminal for status/cleanup too. It requires an existing default VPC and public default subnet, and resolves the Ubuntu 24.04 AMI through Canonical's public SSM parameter. It creates one `t3.small` with standard CPU credits, an encrypted 8 GiB gp3 disk, public IPv4, and its own security group exposing only TCP 80/443. There is no SSH port, IAM role, Elastic IP, DNS-provider change, managed database, or paid model key. Caddy obtains a public certificate for the ephemeral `<public-ip-with-dashes>.sslip.io` name. Its success depends on public DNS and certificate issuance. The script announces readiness only after HTTPS succeeds and `/health` reports a non-mock remote-ingest service with cloud sync disabled.

The gateway starts with `GATEWAY_MODE=remote`, `MOCK=0`, `SIM_NODES=0`, `BASELINE_DAYS=0`, `RECORD=0`, and `INVESTIGATOR=0`. All model keys and database URLs are blank. It waits for real hardware uploads and stores them in local SQLite on EC2. It never connects to the saved Tiger database. This deployment forwards no commands to a physical serial device; the hardware team retains local actuator control.

Hardware sends one JSON reading to `POST https://<announced-host>/api/ingest` using `Authorization: Bearer <CONTROL_TOKEN>`. The reading needs the existing `node`, `test`, `phase`, `ph`, `tds`, `clarity`, `session`, `seq`, and `ph_est` fields; use a registered node such as `tank-01`. Retry the same `session`/`seq` unchanged after a lost acknowledgement. The service deduplicates retries. Dashboard GETs and WebSocket observations are public; mutations require the control token. Treat reading content and node locations as public on this temporary endpoint.

The generated control token is saved only in the private, git-ignored `.env.aws-gateway-control` file. The script never prints it. Give it to the hardware team through a private channel; do not paste it into chat, a URL, source code, or a commit. Resource IDs and the public endpoint are recorded in the private `.env.aws-gateway-state.json` file. These two local files let retries reuse the same deployment and let cleanup identify its resources. Preserve them until cleanup is complete.

Only gateway source, known JSON fixtures and built web assets enter the upload archive. Laptop `.env` files, SQLite databases, recordings, logs, AWS credentials, symlinks, git metadata, local Python environments, and JavaScript dependencies are excluded. A newly generated runtime token is included in that private archive. Upload uses a new private, encrypted S3 object; a presigned download valid for at most one hour is embedded in EC2 user-data without being printed. AWS principals able to inspect user-data or the bootstrap object can access that temporary bearer URL, so keep account access restricted. Source and bucket are removed once readiness succeeds. If startup is interrupted, the source object's one-day lifecycle expiry is a fallback; the bucket itself still needs cleanup.

An expiry timer is armed before package installation and powers off the machine after 24 hours. EC2's terminate-on-instance-shutdown setting then deletes the instance and its root disk. **All readings stored only on that instance are lost on termination.** The timer is a best-effort lifetime control, not a guaranteed dollar cap. An egress shaper limits normal outgoing traffic to 5 Mbit/s, and standard CPU credits avoid CPU surplus charges. EC2, public IPv4, disk, S3 requests/storage and data transfer can still incur charges. An empty S3 bucket and the security group do not automatically disappear when the instance expires; use cleanup below. Do not leave the instance running beyond the approved period.

```sh
# Makes AWS read-only calls; does not print tokens or connection strings.
deploy/aws-gateway.sh status --apply

# Destructive: terminate this instance, delete its SQLite data/disk,
# remove its temporary source bucket/object and dedicated security group.
deploy/aws-gateway.sh down --apply
```

The script never invokes the existing `aws-timescale.sh`, changes your service tier, copies saved cloud/model secrets, pushes git, or edits GoDaddy/Vercel. After an unsuccessful deployment, inspect the AWS console's instance/system logs without posting user-data or secret values publicly, then run cleanup if the instance is no longer needed.

Useful references: [Canonical public AMIs](https://ubuntu.com/aws/docs/aws-how-to/instances/find-ubuntu-images/), [EC2 shutdown behavior](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Using_ChangingInstanceInitiatedShutdownBehavior.html), [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).
