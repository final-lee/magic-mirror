import { resourceDetail, s3EntryDetail } from "./detail";
import { makeResource, sampleServices } from "../test/utils";

const ec2 = sampleServices[0];

test("resourceDetail builds rows from columns (except name) then fields", () => {
  const r = makeResource(
    "i-1",
    { name: "web", id: "i-1", state: "running" },
    { arn: "arn:aws:ec2:r:1:instance/i-1", fields: [{ label: "AMI", value: "ami-1" }], tags: { env: "prod" }, raw: "Instance {}" },
  );
  const d = resourceDetail(r, ec2.types[0], ec2);
  expect(d.title).toBe("web");
  expect(d.subtitle).toBe("EC2 · Instances");
  expect(d.rows).toEqual([
    { label: "Instance ID", value: "i-1" },
    { label: "State", value: "running" },
    { label: "AMI", value: "ami-1" },
  ]);
  expect(d.copy).toEqual({ label: "ARN", value: "arn:aws:ec2:r:1:instance/i-1" });
  expect(d.tags).toEqual({ env: "prod" });
  expect(d.raw).toBe("Instance {}");
});

test("resourceDetail copies ID when there is no ARN and drops empty rows", () => {
  const d = resourceDetail(makeResource("vol-1", { name: "vol-1", id: "", state: "" }), ec2.types[0], ec2);
  expect(d.copy).toEqual({ label: "ID", value: "vol-1" });
  expect(d.rows).toEqual([]);
  expect(d.raw).toBeNull();
});

test("s3EntryDetail for object and folder", () => {
  const obj = s3EntryDetail(
    { name: "logo.svg", key: "images/logo.svg", isFolder: false, size: 2048, lastModified: null, storageClass: "STANDARD" },
    "assets",
    "ap-northeast-2",
  );
  expect(obj.subtitle).toBe("S3 Object");
  expect(obj.copy).toEqual({ label: "S3 URI", value: "s3://assets/images/logo.svg" });
  expect(obj.rows).toContainEqual({ label: "Size", value: "2.0 KB" });
  expect(obj.consoleUrl).toBe(
    "https://s3.console.aws.amazon.com/s3/object/assets?region=ap-northeast-2&prefix=images%2Flogo.svg",
  );
  const folder = s3EntryDetail(
    { name: "images", key: "images/", isFolder: true, size: null, lastModified: null, storageClass: null },
    "assets",
    "ap-northeast-2",
  );
  expect(folder.subtitle).toBe("S3 Folder");
  expect(folder.consoleUrl).toContain("/s3/buckets/assets?");
});
