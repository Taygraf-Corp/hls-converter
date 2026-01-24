import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface HlsConverterConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  apiKey?: string;
  sourceBucket: string;
  targetBucket: string;
  targetFolder: string;
  minCapacity: number;
  maxCapacity: number;
  cpu: number;
  memory: number;
}

export interface HlsConverterStackProps extends cdk.StackProps {
  config: HlsConverterConfig;
}

export class HlsConverterStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: HlsConverterStackProps) {
    super(scope, id, props);

    const { config } = props;

    // ============================================
    // ECR Repository
    // ============================================
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'hls-converter',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 10,
          rulePriority: 1,
          description: 'Keep only 10 images',
        },
      ],
    });

    // ============================================
    // VPC - Use default VPC
    // ============================================
    const vpc = ec2.Vpc.fromLookup(this, 'VPC', {
      isDefault: true,
    });

    // ============================================
    // Security Group
    // ============================================
    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: 'Security group for HLS Converter service',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic'
    );

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic'
    );

    // ============================================
    // Secrets Manager
    // ============================================
    const appSecrets = new secretsmanager.Secret(this, 'AppSecrets', {
      secretName: 'hls-converter/production',
      description: 'Secrets for HLS Converter service',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          SUPABASE_URL: config.supabaseUrl || 'REPLACE_ME',
          SUPABASE_ANON_KEY: config.supabaseAnonKey || 'REPLACE_ME',
          API_KEY: config.apiKey || 'REPLACE_ME',
        }),
        generateStringKey: 'dummy', // Required but we don't use it
      },
    });

    // ============================================
    // CloudWatch Log Group
    // ============================================
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/ecs/hls-converter',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ============================================
    // ECS Cluster
    // ============================================
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'hls-converter-cluster',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ============================================
    // IAM Execution Role
    // ============================================
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: 'hls-converter-execution-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Grant secrets access to execution role
    appSecrets.grantRead(executionRole);

    // ============================================
    // Task Definition
    // ============================================
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      memoryLimitMiB: config.memory,
      cpu: config.cpu,
      family: 'hls-converter',
      executionRole: executionRole,
    });

    // Add container
    const container = taskDefinition.addContainer('app', {
      image: ecs.ContainerImage.fromEcrRepository(this.repository, 'latest'),
      containerName: 'hls-converter',
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'hls-converter',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        SOURCE_BUCKET: config.sourceBucket,
        TARGET_BUCKET: config.targetBucket,
        TARGET_FOLDER: config.targetFolder,
        MAX_CONCURRENT_JOBS: '3',
        TEMP_DIR: '/app/temp',
      },
      secrets: {
        SUPABASE_URL: ecs.Secret.fromSecretsManager(appSecrets, 'SUPABASE_URL'),
        SUPABASE_ANON_KEY: ecs.Secret.fromSecretsManager(appSecrets, 'SUPABASE_ANON_KEY'),
        API_KEY: ecs.Secret.fromSecretsManager(appSecrets, 'API_KEY'),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // ============================================
    // Application Load Balancer
    // ============================================
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      loadBalancerName: 'hls-converter-alb',
      securityGroup,
    });

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targetGroupName: 'hls-converter-tg',
      healthCheck: {
        enabled: true,
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // HTTP Listener
    const httpListener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // ============================================
    // ECS Service
    // ============================================
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition,
      desiredCount: config.minCapacity,
      serviceName: 'hls-converter-service',
      assignPublicIp: true,
      securityGroups: [securityGroup],
      circuitBreaker: {
        rollback: true,
      },
      enableExecuteCommand: true, // Allows exec into containers for debugging
    });

    // Attach service to target group
    this.service.attachToApplicationTargetGroup(targetGroup);

    // ============================================
    // Auto Scaling
    // ============================================
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: config.minCapacity,
      maxCapacity: config.maxCapacity,
    });

    // Scale based on CPU utilization
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Scale based on memory utilization
    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Scale based on request count
    scaling.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 100,
      targetGroup,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // ============================================
    // Outputs
    // ============================================
    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR Repository URI',
      exportName: 'HlsConverterRepositoryUri',
    });

    new cdk.CfnOutput(this, 'RepositoryName', {
      value: this.repository.repositoryName,
      description: 'ECR Repository Name',
      exportName: 'HlsConverterRepositoryName',
    });

    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'Load Balancer DNS Name',
      exportName: 'HlsConverterLoadBalancerDNS',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `http://${this.loadBalancer.loadBalancerDnsName}`,
      description: 'API URL',
      exportName: 'HlsConverterApiUrl',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS Cluster Name',
      exportName: 'HlsConverterClusterName',
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.service.serviceName,
      description: 'ECS Service Name',
      exportName: 'HlsConverterServiceName',
    });

    new cdk.CfnOutput(this, 'SecretsArn', {
      value: appSecrets.secretArn,
      description: 'Secrets Manager ARN - Update secrets here',
      exportName: 'HlsConverterSecretsArn',
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group Name',
      exportName: 'HlsConverterLogGroupName',
    });
  }
}
