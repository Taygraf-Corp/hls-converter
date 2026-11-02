#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}       HLS Converter - AWS Deployment Script${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# Check prerequisites
check_prerequisites() {
    echo -e "${YELLOW}Checking prerequisites...${NC}"
    
    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        echo -e "${RED}✗ AWS CLI is not installed${NC}"
        echo "  Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
        exit 1
    fi
    echo -e "${GREEN}✓ AWS CLI installed${NC}"
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}✗ Docker is not installed${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Docker installed${NC}"
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        echo -e "${RED}✗ AWS credentials not configured${NC}"
        echo "  Run: aws configure"
        exit 1
    fi
    echo -e "${GREEN}✓ AWS credentials configured${NC}"
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}✗ Node.js is not installed${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Node.js installed${NC}"
    
    echo ""
}

# Get AWS account info
get_aws_info() {
    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    AWS_REGION=${AWS_REGION:-$(aws configure get region)}
    AWS_REGION=${AWS_REGION:-ca-central-1}  # production region
    
    echo -e "${BLUE}AWS Configuration:${NC}"
    echo "  Account ID: $AWS_ACCOUNT_ID"
    echo "  Region: $AWS_REGION"
    echo ""
}

# Install CDK dependencies
install_dependencies() {
    echo -e "${YELLOW}Installing CDK dependencies...${NC}"
    cd infra
    npm install
    cd ..
    echo -e "${GREEN}✓ Dependencies installed${NC}"
    echo ""
}

# Bootstrap CDK (if needed)
bootstrap_cdk() {
    echo -e "${YELLOW}Bootstrapping CDK (if needed)...${NC}"
    cd infra
    npx cdk bootstrap aws://$AWS_ACCOUNT_ID/$AWS_REGION 2>/dev/null || true
    cd ..
    echo -e "${GREEN}✓ CDK bootstrapped${NC}"
    echo ""
}

# Deploy infrastructure
deploy_infrastructure() {
    echo -e "${YELLOW}Deploying infrastructure...${NC}"
    cd infra
    
    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        npm install
    fi
    
    # Review first; the deploy asks before any security-relevant change.
    # The stack needs the running image digest: -c imageDigest=sha256:...
    npx cdk diff "$@"
    npx cdk deploy --require-approval broadening "$@"
    
    cd ..
    echo -e "${GREEN}✓ Infrastructure deployed${NC}"
    echo ""
}

# Build and push Docker image
build_and_push() {
    echo -e "${YELLOW}Building Docker image...${NC}"
    
    ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/hls-converter"
    
    # Login to ECR
    aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_URI
    
    # Build image
    docker build -t hls-converter .
    
    # Tag image
    docker tag hls-converter:latest $ECR_URI:latest
    docker tag hls-converter:latest $ECR_URI:$(git rev-parse --short HEAD 2>/dev/null || echo "manual")
    
    # Push image
    echo -e "${YELLOW}Pushing image to ECR...${NC}"
    docker push $ECR_URI:latest
    docker push $ECR_URI:$(git rev-parse --short HEAD 2>/dev/null || echo "manual")
    
    echo -e "${GREEN}✓ Docker image pushed to ECR${NC}"
    echo ""
}

# Update ECS service
update_service() {
    echo -e "${YELLOW}Updating ECS service...${NC}"
    
    aws ecs update-service \
        --cluster hls-converter-cluster \
        --service hls-converter-service \
        --force-new-deployment \
        --region $AWS_REGION \
        > /dev/null
    
    echo -e "${GREEN}✓ ECS service updated${NC}"
    echo ""
}

# Wait for deployment
wait_for_deployment() {
    echo -e "${YELLOW}Waiting for deployment to stabilize...${NC}"
    
    aws ecs wait services-stable \
        --cluster hls-converter-cluster \
        --services hls-converter-service \
        --region $AWS_REGION
    
    echo -e "${GREEN}✓ Deployment complete${NC}"
    echo ""
}

# Get outputs
show_outputs() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}Deployment Complete!${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    
    # Get ALB DNS from CloudFormation outputs
    ALB_DNS=$(aws cloudformation describe-stacks \
        --stack-name HlsConverterStack \
        --query "Stacks[0].Outputs[?OutputKey=='LoadBalancerDNS'].OutputValue" \
        --output text \
        --region $AWS_REGION 2>/dev/null || echo "")
    
    if [ -n "$ALB_DNS" ]; then
        echo -e "${GREEN}API URL:${NC} http://$ALB_DNS"
        echo ""
        echo -e "${YELLOW}Test the deployment:${NC}"
        echo "  curl http://$ALB_DNS/health"
        echo ""
        echo -e "${YELLOW}Upload a video:${NC}"
        echo "  curl -X POST http://$ALB_DNS/api/upload \\"
        echo "    -H \"Authorization: Bearer YOUR_API_KEY\" \\"
        echo "    -F \"video=@video.mp4\""
    fi
    
    echo ""
    echo -e "${YELLOW}Useful commands:${NC}"
    echo "  View logs:    aws logs tail /ecs/hls-converter --follow"
    echo "  Scale up:     aws ecs update-service --cluster hls-converter-cluster --service hls-converter-service --desired-count 2"
    echo "  Redeploy:     npm run deploy"
    echo ""
}

# Main
# The old full / image-only paths pushed and deployed the mutable `latest` tag
# with --force-new-deployment. Image rollouts now go through the pinned script,
# which keeps the current task definition and records a rollback target
# (CTO review 2026-11-02, finding 4).
case "${1:-}" in
    --infra-only)
        shift
        check_prerequisites
        get_aws_info
        install_dependencies
        bootstrap_cdk
        deploy_infrastructure "$@"
        ;;
    --image-only|"")
        shift || true
        exec "$(dirname "$0")/deploy-image-pinned.sh" "$@"
        ;;
    --help|-h)
        echo "Usage: ./scripts/deploy.sh [--image-only [--plan|--apply|--rollback <arn>]] | --infra-only -c imageDigest=sha256:..."
        echo ""
        echo "  --image-only   Pinned image rollout (scripts/deploy-image-pinned.sh); default"
        echo "  --infra-only   CDK diff + deploy; needs -c imageDigest=sha256:<running digest>"
        echo ""
        echo "Environment: AWS_REGION (default ca-central-1)"
        ;;
    *)
        echo "unknown option: $1 (see --help)" >&2
        exit 2
        ;;
esac
