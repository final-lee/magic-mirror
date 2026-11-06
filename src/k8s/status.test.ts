import { readyTone, statusTone } from "./status";

test("status tone: kubectl-style reasons split into ok, done, waiting and failing", () => {
  expect(statusTone("Running")).toBe("ok");
  expect(statusTone("Completed")).toBe("done");
  expect(statusTone("Pending")).toBe("warn");
  expect(statusTone("Terminating")).toBe("warn");
  for (const bad of ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "OOMKilled", "CreateContainerConfigError", "Failed", "Evicted"]) {
    expect(statusTone(bad)).toBe("bad");
  }
  expect(statusTone("SomethingNew")).toBe("plain");
  // 객체 원형의 이름은 알려진 낱말이 아니다
  expect(statusTone("constructor")).toBe("plain");
});

test("status tone: Init reasons are waiting unless they fail; comma lists take the worst", () => {
  expect(statusTone("Init:0/2")).toBe("warn");
  expect(statusTone("Init:PodInitializing")).toBe("warn");
  expect(statusTone("Init:CrashLoopBackOff")).toBe("bad");
  expect(statusTone("Ready,SchedulingDisabled")).toBe("warn");
  expect(statusTone("Ready")).toBe("ok");
});

test("ready tone: all, some, none, zero wanted, and the Ready condition", () => {
  expect(readyTone("3/3")).toBe("ok");
  expect(readyTone("1/3")).toBe("warn");
  expect(readyTone("0/3")).toBe("bad");
  expect(readyTone("0/0")).toBe("plain");
  expect(readyTone("True")).toBe("ok");
  expect(readyTone("False")).toBe("bad");
  expect(readyTone("7")).toBeNull();
});
