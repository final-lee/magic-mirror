export const workflowExamples: Record<string, string> = {
  "hello-world": `apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: hello-world-
spec:
  entrypoint: hello
  templates:
    - name: hello
      container:
        image: alpine:3.19
        command: [echo, hello world]
`,
  steps: `apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: steps-
spec:
  entrypoint: main
  templates:
    - name: main
      steps:
        - - name: hello
            template: echo
        - - name: goodbye
            template: echo
    - name: echo
      container:
        image: alpine:3.19
        command: [echo, hello]
`,
  dag: `apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: dag-
spec:
  entrypoint: main
  templates:
    - name: main
      dag:
        tasks:
          - name: first
            template: echo
          - name: second
            dependencies: [first]
            template: echo
    - name: echo
      container:
        image: alpine:3.19
        command: [echo, hello]
`,
  parameters: `apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: parameters-
spec:
  entrypoint: main
  arguments:
    parameters:
      - name: message
        value: hello
  templates:
    - name: main
      container:
        image: alpine:3.19
        command: [echo, "{{workflow.parameters.message}}"]
`,
};
