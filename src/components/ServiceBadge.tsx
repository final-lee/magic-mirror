const COLORS: Record<string, string> = {
  ec2: "#f58536",
  s3: "#3f8624",
  lambda: "#ed7100",
  rds: "#3b48cc",
  ecs: "#ed7100",
  eks: "#ed7100",
  vpc: "#8c4fff",
  iam: "#dd344c",
  dynamodb: "#3b48cc",
  logs: "#e7157b",
  cloudfront: "#8c4fff",
  sqs: "#e7157b",
  sns: "#e7157b",
  ecr: "#ed7100",
  route53: "#8c4fff",
  secretsmanager: "#dd344c",
};

export function ServiceBadge({ service }: { service: { id: string; name: string } }) {
  return (
    <span className="badge" style={{ background: COLORS[service.id] ?? "#666" }} aria-hidden="true">
      {service.name.slice(0, 2).toUpperCase()}
    </span>
  );
}
