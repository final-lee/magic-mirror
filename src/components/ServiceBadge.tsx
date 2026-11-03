const COLORS: Record<string, string> = {
  ec2: "var(--badge-orange)",
  s3: "var(--badge-green)",
  lambda: "var(--badge-orange)",
  rds: "var(--badge-blue)",
  ecs: "var(--badge-orange)",
  eks: "var(--badge-orange)",
  vpc: "var(--badge-purple)",
  iam: "var(--badge-red)",
  dynamodb: "var(--badge-blue)",
  logs: "var(--badge-pink)",
  cloudfront: "var(--badge-purple)",
  sqs: "var(--badge-pink)",
  sns: "var(--badge-pink)",
  ecr: "var(--badge-orange)",
  route53: "var(--badge-purple)",
  secretsmanager: "var(--badge-red)",
};

export function ServiceBadge({ service }: { service: { id: string; name: string } }) {
  return (
    <span className="badge" style={{ background: COLORS[service.id] ?? "var(--badge-gray)", color: "var(--badge-text)" }} aria-hidden="true">
      {service.name.slice(0, 2).toUpperCase()}
    </span>
  );
}
