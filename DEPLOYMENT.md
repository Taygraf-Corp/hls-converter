# AWS Deployment Guide

This guide explains how to deploy the HLS Converter service to AWS using CDK (Infrastructure as Code).

## Architecture

```
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│    Internet     │────▶│  Application Load   │────▶│   ECS Fargate   │
│                 │     │  Balancer (ALB)     │     │   (Container)   │
└─────────────────┘     └─────────────────────┘     └─────────────────┘
                                                           │
                              ┌─────────────────────────────┴──────┐
                              │                                    │
                              ▼                                    ▼
                    ┌─────────────────┐                 ┌─────────────────┐
                    │     Secrets     │                 │   CloudWatch    │
                    │     Manager     │                 │      Logs       │
                    └─────────────────┘                 └─────────────────┘
```

## Prerequisites

1. **AWS CLI** - [Install Guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
2. **Docker** - [Install Guide](https://docs.docker.com/get-docker/)
3. **Node.js 18+** - [Install Guide](https://nodejs.org/)
4. **AWS Account** with appropriate permissions

## Quick Start

### 1. Configure AWS Credentials

```bash
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Enter your default region (e.g., us-east-1)
```

### 2. Set Environment Variables

Create a `.env.deploy` file (or export these variables):

```bash
export AWS_REGION=us-east-1
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_ANON_KEY=your-anon-key
export API_KEY=your-api-key
```

### 3. Deploy

```bash
# Make the deploy script executable
chmod +x scripts/deploy.sh

# Run full deployment
./scripts/deploy.sh
```

This will:
1. ✅ Install CDK dependencies
2. ✅ Bootstrap CDK (if needed)
3. ✅ Deploy infrastructure (ECS, ALB, ECR, Secrets)
4. ✅ Build Docker image
5. ✅ Push to ECR
6. ✅ Update ECS service
7. ✅ Wait for deployment to stabilize

## Manual Deployment Steps

If you prefer to run steps manually:

### Step 1: Install CDK Dependencies

```bash
cd infra
npm install
cd ..
```

### Step 2: Bootstrap CDK

```bash
cd infra
npx cdk bootstrap
cd ..
```

### Step 3: Deploy Infrastructure

```bash
cd infra
npx cdk deploy --require-approval never
cd ..
```

### Step 4: Update Secrets

After the first deployment, update the secrets in AWS Secrets Manager:

```bash
# Get the secrets ARN from CDK output
SECRETS_ARN=$(aws cloudformation describe-stacks \
  --stack-name HlsConverterStack \
  --query "Stacks[0].Outputs[?OutputKey=='SecretsArn'].OutputValue" \
  --output text)

# Update secrets
aws secretsmanager put-secret-value \
  --secret-id $SECRETS_ARN \
  --secret-string '{
    "SUPABASE_URL": "https://your-project.supabase.co",
    "SUPABASE_ANON_KEY": "your-actual-anon-key",
    "API_KEY": "your-actual-api-key"
  }'
```

### Step 5: Build and Push Docker Image

```bash
# Get AWS account ID and region
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=$(aws configure get region)

# Login to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Build and tag
docker build -t hls-converter .
docker tag hls-converter:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/hls-converter:latest

# Push
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/hls-converter:latest
```

### Step 6: Update ECS Service

```bash
aws ecs update-service \
  --cluster hls-converter-cluster \
  --service hls-converter-service \
  --force-new-deployment
```

### Step 7: Wait for Deployment

```bash
aws ecs wait services-stable \
  --cluster hls-converter-cluster \
  --services hls-converter-service
```

## Configuration

### CDK Context Variables

You can customize the deployment using CDK context:

```bash
cd infra
npx cdk deploy \
  -c minCapacity=1 \
  -c maxCapacity=10 \
  -c cpu=4096 \
  -c memory=8192 \
  -c sourceBucket=MyBucket \
  -c targetBucket=MyBucket \
  -c targetFolder=hls-converted
```

### Available Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `minCapacity` | 1 | Minimum number of tasks |
| `maxCapacity` | 5 | Maximum number of tasks |
| `cpu` | 2048 | CPU units (1024 = 1 vCPU) |
| `memory` | 4096 | Memory in MB |
| `sourceBucket` | FlutterFlow | Source storage bucket |
| `targetBucket` | FlutterFlow | Target storage bucket |
| `targetFolder` | converted | Target folder for HLS files |

### Resource Sizing Guide

| Use Case | CPU | Memory | Min/Max Tasks |
|----------|-----|--------|---------------|
| Low traffic | 1024 | 2048 | 1/2 |
| Medium traffic | 2048 | 4096 | 1/5 |
| High traffic | 4096 | 8192 | 2/10 |
| Enterprise | 4096 | 16384 | 3/20 |

## Operations

### View Logs

```bash
# Follow logs in real-time
aws logs tail /ecs/hls-converter --follow

# Get last 100 log events
aws logs tail /ecs/hls-converter --since 1h
```

### Scale Service

```bash
# Scale to 3 instances
aws ecs update-service \
  --cluster hls-converter-cluster \
  --service hls-converter-service \
  --desired-count 3

# Scale to 0 (stop service)
aws ecs update-service \
  --cluster hls-converter-cluster \
  --service hls-converter-service \
  --desired-count 0
```

### Redeploy (Same Image)

```bash
aws ecs update-service \
  --cluster hls-converter-cluster \
  --service hls-converter-service \
  --force-new-deployment
```

### Deploy New Version

```bash
# Build and push new image
./scripts/deploy.sh --image-only
```

### Debug Container

```bash
# Execute command in running container
aws ecs execute-command \
  --cluster hls-converter-cluster \
  --task <task-id> \
  --container hls-converter \
  --command "/bin/sh" \
  --interactive
```

### Get Service Status

```bash
aws ecs describe-services \
  --cluster hls-converter-cluster \
  --services hls-converter-service \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount,Pending:pendingCount}'
```

## Updating Secrets

### Via AWS Console

1. Go to AWS Secrets Manager
2. Find secret: `hls-converter/production`
3. Click "Retrieve secret value"
4. Click "Edit"
5. Update values and save

### Via CLI

```bash
aws secretsmanager put-secret-value \
  --secret-id hls-converter/production \
  --secret-string '{
    "SUPABASE_URL": "https://new-project.supabase.co",
    "SUPABASE_ANON_KEY": "new-key",
    "API_KEY": "new-api-key"
  }'

# Restart service to pick up new secrets
aws ecs update-service \
  --cluster hls-converter-cluster \
  --service hls-converter-service \
  --force-new-deployment
```

## Adding HTTPS (SSL/TLS)

### Option 1: AWS Certificate Manager

```bash
# Request certificate
aws acm request-certificate \
  --domain-name api.yourdomain.com \
  --validation-method DNS

# After DNS validation, add HTTPS listener via AWS Console
# or update CDK stack
```

### Option 2: Update CDK Stack

Add to `lib/hls-converter-stack.ts`:

```typescript
// Import ACM certificate
const certificate = acm.Certificate.fromCertificateArn(
  this, 'Certificate',
  'arn:aws:acm:region:account:certificate/xxx'
);

// Add HTTPS listener
this.loadBalancer.addListener('HttpsListener', {
  port: 443,
  protocol: elbv2.ApplicationProtocol.HTTPS,
  certificates: [certificate],
  defaultTargetGroups: [targetGroup],
});

// Redirect HTTP to HTTPS
httpListener.addAction('HttpRedirect', {
  action: elbv2.ListenerAction.redirect({
    protocol: 'HTTPS',
    port: '443',
    permanent: true,
  }),
});
```

## Destroy Infrastructure

⚠️ **Warning**: This will delete all resources including data!

```bash
cd infra
npx cdk destroy
```

To keep the ECR repository (with images):
```bash
# Manually delete via AWS Console or update removalPolicy in CDK
```

## Cost Estimation

| Resource | Configuration | Monthly Cost (approx) |
|----------|--------------|----------------------|
| ECS Fargate | 2 vCPU, 4GB RAM, 24/7 | ~$70-100 |
| ALB | Per hour + LCU | ~$20-30 |
| ECR | Storage (10 images) | ~$1-5 |
| CloudWatch Logs | Ingestion + Storage | ~$5-10 |
| Secrets Manager | Per secret | ~$0.40 |
| **Total** | | **~$100-150/month** |

*Costs vary by region and actual usage. Use [AWS Calculator](https://calculator.aws/) for accurate estimates.*

## Troubleshooting

### Task fails to start

```bash
# Check task stopped reason
aws ecs describe-tasks \
  --cluster hls-converter-cluster \
  --tasks $(aws ecs list-tasks --cluster hls-converter-cluster --query 'taskArns[0]' --output text)
```

### Health check failing

```bash
# Check container logs
aws logs tail /ecs/hls-converter --since 10m

# Test health endpoint locally
docker run -p 3000:3000 hls-converter
curl http://localhost:3000/health
```

### Out of memory

Increase memory in CDK:
```bash
npx cdk deploy -c memory=8192
```

### Image pull errors

```bash
# Verify ECR login
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Check image exists
aws ecr describe-images --repository-name hls-converter
```

## CI/CD Integration

### GitHub Actions

See `.github/workflows/deploy.yml` for automated deployment on push to main branch.

### Manual Trigger

```bash
# Deploy infrastructure only
./scripts/deploy.sh --infra-only

# Deploy new image only
./scripts/deploy.sh --image-only

# Full deployment
./scripts/deploy.sh
```

## Support

- Check CloudWatch Logs for errors
- Review ECS service events in AWS Console
- Ensure secrets are correctly configured
- Verify security group allows traffic on port 3000
