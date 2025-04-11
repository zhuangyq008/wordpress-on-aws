import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';

export class WordpressThreeTierStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 创建VPC
    const vpc = new ec2.Vpc(this, 'WordpressVPC', {
      maxAzs: 2,
      natGateways: 1
    });

    // 创建安全组
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Security group for ALB',
      allowAllOutbound: true
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS traffic');

    const ecsSg = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      description: 'Security group for ECS',
      allowAllOutbound: true
    });
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(80), 'Allow traffic from ALB');

    const dbSg = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Security group for RDS',
      allowAllOutbound: true
    });
    dbSg.addIngressRule(ecsSg, ec2.Port.tcp(3306), 'Allow MySQL traffic from ECS');

    // 创建RDS数据库
    const dbPassword = new secretsmanager.Secret(this, 'DBPassword', {
      secretName: 'wordpress-db-password',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 16
      }
    });

    const dbInstance = new rds.DatabaseInstance(this, 'WordpressDatabase', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      databaseName: 'wordpress',
      credentials: rds.Credentials.fromSecret(dbPassword),
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false, // 生产环境建议设为true
      storageEncrypted: true
    });

    // 创建ECS集群
    const cluster = new ecs.Cluster(this, 'WordpressCluster', {
      vpc,
      containerInsights: true
    });

    // 创建ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'WordpressALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSg
    });

    const httpListener = alb.addListener('HttpListener', {
      port: 80,
      open: true
    });

    // ECS任务定义
    const taskRole = new iam.Role(this, 'WordpressTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'WordpressTaskDef', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole
    });

    const wordpressContainer = taskDefinition.addContainer('WordpressContainer', {
      image: ecs.ContainerImage.fromRegistry('wordpress:latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'wordpress' }),
      environment: {
        'WORDPRESS_DB_HOST': dbInstance.dbInstanceEndpointAddress,
        'WORDPRESS_DB_NAME': 'wordpress',
        'WORDPRESS_DB_USER': 'admin'
      },
      secrets: {
        'WORDPRESS_DB_PASSWORD': ecs.Secret.fromSecretsManager(dbPassword)
      }
    });

    wordpressContainer.addPortMappings({
      containerPort: 80
    });

    // ECS服务
    const wordpressService = new ecs.FargateService(this, 'WordpressService', {
      cluster,
      taskDefinition,
      desiredCount: 2,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    // 设置ALB目标组
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'WordpressTargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30)
      }
    });

    wordpressService.attachToApplicationTargetGroup(targetGroup);
    httpListener.addTargetGroups('WordpressTargetGroup', {
      targetGroups: [targetGroup]
    });

    // 设置自动扩展
    const scaling = wordpressService.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60)
    });

    // 创建CloudFront分发
    const distribution = new cloudfront.Distribution(this, 'WordpressDistribution', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY
        }),
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        compress: true
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100
    });

    // 输出有用的信息
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: alb.loadBalancerDnsName,
      description: 'ALB DNS Name'
    });

    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront Domain Name'
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: dbInstance.dbInstanceEndpointAddress,
      description: 'RDS Database Endpoint'
    });
  }
}