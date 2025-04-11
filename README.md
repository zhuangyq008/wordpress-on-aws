# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

  这个三层架构解释:

  1. 表现层: CloudFront CDN分发内容
  2. 应用层: ECS Fargate运行WordPress容器，通过ELB负载均衡
  3. 数据层: RDS MySQL存储WordPress数据

  安全考量已包括:

  - 使用安全组限制流量
  - 数据库密码存储在Secrets Manager
  - 私有子网部署ECS和RDS
  - HTTPS重定向配置
