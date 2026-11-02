import { tokenizeYaml, type YamlToken } from "./YamlView";

const kinds = (line: YamlToken[]) => line.filter((t) => t.kind !== "plain").map((t) => `${t.kind}:${t.text}`);

const SAMPLE = `apiVersion: v1
kind: Pod
metadata:
  name: "web-1"   # 이름
  labels:
    app: web
  annotations:
    note: |
      first line: not a key
      # not a comment

    url: http://x:8080/a#b
spec:
  containers:
  - name: app
    image: nginx:1.27
    ports:
    - containerPort: 80
      hostNetwork: false
    args: []
    env: null
data:
  password: ••••
---
# 끝
`;

test("joining the tokens gives back every line exactly", () => {
  const lines = tokenizeYaml(SAMPLE);
  expect(lines.map((l) => l.map((t) => t.text).join("")).join("\n")).toBe(SAMPLE);
});

test("keys, scalars, comments, list markers, block strings and masked values get their own kinds", () => {
  const l = tokenizeYaml(SAMPLE);
  expect(kinds(l[0])).toEqual(["key:apiVersion", "punct::", "str:v1"]);
  expect(kinds(l[3])).toEqual(["key:name", "punct::", 'str:"web-1"', "comment:# 이름"]);
  expect(kinds(l[7])).toEqual(["key:note", "punct::", "punct:|"]);
  expect(kinds(l[8])).toEqual(["str:      first line: not a key"]);
  expect(kinds(l[9])).toEqual(["str:      # not a comment"]);
  expect(kinds(l[11])).toEqual(["key:url", "punct::", "str:http://x:8080/a#b"]);
  expect(kinds(l[14])).toEqual(["punct:-", "key:name", "punct::", "str:app"]);
  expect(kinds(l[15])).toEqual(["key:image", "punct::", "str:nginx:1.27"]);
  expect(kinds(l[17])).toEqual(["punct:-", "key:containerPort", "punct::", "num:80"]);
  expect(kinds(l[18])).toEqual(["key:hostNetwork", "punct::", "bool:false"]);
  expect(kinds(l[19])).toEqual(["key:args", "punct::", "punct:[]"]);
  expect(kinds(l[20])).toEqual(["key:env", "punct::", "bool:null"]);
  expect(kinds(l[22])).toEqual(["key:password", "punct::", "mask:••••"]);
  expect(kinds(l[23])).toEqual(["punct:---"]);
  expect(kinds(l[24])).toEqual(["comment:# 끝"]);
});
