import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as tar from "tar";
import yaml from "js-yaml";
import { createTestBundle, getFixturePath } from "../../helpers/create-test-bundle";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function parseYamlFile<T>(filePath: string): T {
  return yaml.load(fs.readFileSync(filePath, "utf8")) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Test Fixtures — Scenario Directories", () => {
  describe("Scenario 1: wrong-db-endpoint", () => {
    const dir = getFixturePath("wrong-db-endpoint");

    it("fixture directory exists", () => {
      expect(exists(dir)).toBe(true);
    });

    it("has version.yaml", () => {
      expect(exists(path.join(dir, "version.yaml"))).toBe(true);
    });

    it("has analyzer output JSON", () => {
      expect(exists(path.join(dir, "analyzers", "output.json"))).toBe(true);
    });

    it("analyzer output contains a warn severity entry", () => {
      const raw = fs.readFileSync(path.join(dir, "analyzers", "output.json"), "utf8");
      const data = JSON.parse(raw) as Array<{
        name: string;
        insight: { severity: string; primary: string; detail: string };
      }>;
      expect(Array.isArray(data)).toBe(true);
      const warn = data.find((e) => e.insight.severity === "warn");
      expect(warn).toBeDefined();
    });

    it("has pod YAML in cluster-resources/pods/default", () => {
      const podDir = path.join(dir, "cluster-resources", "pods", "default");
      expect(exists(podDir)).toBe(true);
      const yamls = fs.readdirSync(podDir).filter((f) => f.endsWith(".yaml"));
      expect(yamls.length).toBeGreaterThan(0);
    });

    it("pod YAML shows Running phase but not Ready", () => {
      const podDir = path.join(dir, "cluster-resources", "pods", "default");
      const yamlContent = fs.readFileSync(path.join(podDir, "app-pod.yaml"), "utf8");
      expect(yamlContent).toContain("phase: Running");
      expect(yamlContent).toContain('status: "False"');
    });

    it("pod YAML parses as a valid Pod resource", () => {
      const podPath = path.join(dir, "cluster-resources", "pods", "default", "app-pod.yaml");
      const pod = parseYamlFile<{
        apiVersion: string;
        kind: string;
        metadata: { name: string; namespace: string };
        status: { phase: string };
      }>(podPath);

      expect(pod.apiVersion).toBe("v1");
      expect(pod.kind).toBe("Pod");
      expect(pod.metadata.name).toBe("app-pod");
      expect(pod.metadata.namespace).toBe("default");
      expect(pod.status.phase).toBe("Running");
    });

    it("has services in cluster-resources/services/default (no db service)", () => {
      const svcDir = path.join(dir, "cluster-resources", "services", "default");
      expect(exists(svcDir)).toBe(true);
      const files = fs.readdirSync(svcDir);
      expect(files.length).toBeGreaterThan(0);
      // None of the service files should be named db-service or similar
      const hasDbService = files.some((f) => f.toLowerCase().includes("db"));
      expect(hasDbService).toBe(false);
    });

    it("service YAML parses as a valid Service resource", () => {
      const servicePath = path.join(
        dir,
        "cluster-resources",
        "services",
        "default",
        "app-service.yaml"
      );
      const service = parseYamlFile<{
        apiVersion: string;
        kind: string;
        metadata: { name: string; namespace: string };
      }>(servicePath);

      expect(service.apiVersion).toBe("v1");
      expect(service.kind).toBe("Service");
      expect(service.metadata.name).toBe("app-service");
      expect(service.metadata.namespace).toBe("default");
    });

    it("has events JSON with connection-related warnings", () => {
      const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
      expect(exists(eventsPath)).toBe(true);
      const events = JSON.parse(fs.readFileSync(eventsPath, "utf8")) as Array<{
        type: string;
        reason: string;
        message: string;
      }>;
      expect(Array.isArray(events)).toBe(true);
      const warnings = events.filter((e) => e.type === "Warning");
      expect(warnings.length).toBeGreaterThan(0);
    });

    it("has app log file with DNS lookup error", () => {
      const logPath = path.join(dir, "logs", "app", "app-pod.log");
      expect(exists(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf8");
      expect(content).toContain("lookup db.internal: no such host");
    });

    it("has cluster_version.json", () => {
      expect(exists(path.join(dir, "cluster-info", "cluster_version.json"))).toBe(true);
    });
  });

  describe("Scenario 2: missing-secret-crashloop", () => {
    const dir = getFixturePath("missing-secret-crashloop");

    it("fixture directory exists", () => {
      expect(exists(dir)).toBe(true);
    });

    it("has version.yaml", () => {
      expect(exists(path.join(dir, "version.yaml"))).toBe(true);
    });

    it("has analyzer output JSON with error severity", () => {
      const raw = fs.readFileSync(path.join(dir, "analyzers", "output.json"), "utf8");
      const data = JSON.parse(raw) as Array<{
        name: string;
        insight: { severity: string; primary: string; detail: string };
      }>;
      const error = data.find((e) => e.insight.severity === "error");
      expect(error).toBeDefined();
    });

    it("pod YAML shows CrashLoopBackOff with restartCount 8", () => {
      const podPath = path.join(dir, "cluster-resources", "pods", "default", "app-pod.yaml");
      expect(exists(podPath)).toBe(true);
      const yaml = fs.readFileSync(podPath, "utf8");
      expect(yaml).toContain("CrashLoopBackOff");
      expect(yaml).toContain("restartCount: 8");
    });

    it("deployment references app-credentials secret", () => {
      const depDir = path.join(dir, "cluster-resources", "deployments", "default");
      expect(exists(depDir)).toBe(true);
      const yamls = fs.readdirSync(depDir).filter((f) => f.endsWith(".yaml"));
      expect(yamls.length).toBeGreaterThan(0);
      const content = fs.readFileSync(path.join(depDir, yamls[0]), "utf8");
      expect(content).toContain("app-credentials");
    });

    it("deployment YAML parses as a valid Deployment resource", () => {
      const deploymentPath = path.join(
        dir,
        "cluster-resources",
        "deployments",
        "default",
        "app-deployment.yaml"
      );
      const deployment = parseYamlFile<{
        apiVersion: string;
        kind: string;
        metadata: { name: string; namespace: string };
      }>(deploymentPath);

      expect(deployment.apiVersion).toBe("apps/v1");
      expect(deployment.kind).toBe("Deployment");
      expect(deployment.metadata.name).toBe("app-deployment");
      expect(deployment.metadata.namespace).toBe("default");
    });

    it("secrets directory does NOT contain app-credentials", () => {
      const secretsDir = path.join(dir, "cluster-resources", "secrets", "default");
      expect(exists(secretsDir)).toBe(true);
      const yamls = fs.readdirSync(secretsDir).filter((f) => f.endsWith(".yaml"));
      const hasAppCreds = yamls.some((f) => f.includes("app-credentials"));
      expect(hasAppCreds).toBe(false);
      // Confirm none of the secret YAML files contain 'app-credentials' as a name
      const contentMatches = yamls.some((f) => {
        const c = fs.readFileSync(path.join(secretsDir, f), "utf8");
        return c.includes("name: app-credentials");
      });
      expect(contentMatches).toBe(false);
    });

    it("existing secret YAML parses as a valid Secret resource", () => {
      const secretPath = path.join(
        dir,
        "cluster-resources",
        "secrets",
        "default",
        "other-secret.yaml"
      );
      const secret = parseYamlFile<{
        apiVersion: string;
        kind: string;
        metadata: { name: string; namespace: string };
      }>(secretPath);

      expect(secret.apiVersion).toBe("v1");
      expect(secret.kind).toBe("Secret");
      expect(secret.metadata.name).toBe("other-secret");
      expect(secret.metadata.namespace).toBe("default");
    });

    it("events include FailedMount and BackOff events", () => {
      const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
      const events = JSON.parse(fs.readFileSync(eventsPath, "utf8")) as Array<{
        reason: string;
      }>;
      const reasons = events.map((e) => e.reason);
      expect(reasons).toContain("FailedMount");
      expect(reasons).toContain("BackOff");
    });

    it("log file contains secret-not-found error", () => {
      const logPath = path.join(dir, "logs", "app", "app-pod.log");
      expect(exists(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf8");
      expect(content).toContain("secret app-credentials not found");
    });
  });

  describe("Scenario 3: bad-image-tag", () => {
    const dir = getFixturePath("bad-image-tag");

    it("fixture directory exists", () => {
      expect(exists(dir)).toBe(true);
    });

    it("has version.yaml", () => {
      expect(exists(path.join(dir, "version.yaml"))).toBe(true);
    });

    it("has analyzer output JSON with error severity", () => {
      const raw = fs.readFileSync(path.join(dir, "analyzers", "output.json"), "utf8");
      const data = JSON.parse(raw) as Array<{
        name: string;
        insight: { severity: string; primary: string; detail: string };
      }>;
      const error = data.find((e) => e.insight.severity === "error");
      expect(error).toBeDefined();
    });

    it("pod YAML shows ImagePullBackOff waiting state", () => {
      const podPath = path.join(dir, "cluster-resources", "pods", "default", "app-pod.yaml");
      expect(exists(podPath)).toBe(true);
      const yaml = fs.readFileSync(podPath, "utf8");
      expect(yaml).toContain("ImagePullBackOff");
    });

    it("deployment references invalid image tag v999.99.99", () => {
      const depDir = path.join(dir, "cluster-resources", "deployments", "default");
      expect(exists(depDir)).toBe(true);
      const yamls = fs.readdirSync(depDir).filter((f) => f.endsWith(".yaml"));
      expect(yamls.length).toBeGreaterThan(0);
      const content = fs.readFileSync(path.join(depDir, yamls[0]), "utf8");
      expect(content).toContain("myapp:v999.99.99");
    });

    it("deployment YAML parses as a valid Deployment resource", () => {
      const deploymentPath = path.join(
        dir,
        "cluster-resources",
        "deployments",
        "default",
        "app-deployment.yaml"
      );
      const deployment = parseYamlFile<{
        apiVersion: string;
        kind: string;
        metadata: { name: string; namespace: string };
      }>(deploymentPath);

      expect(deployment.apiVersion).toBe("apps/v1");
      expect(deployment.kind).toBe("Deployment");
      expect(deployment.metadata.name).toBe("app-deployment");
      expect(deployment.metadata.namespace).toBe("default");
    });

    it("events include ErrImagePull and Failed reasons", () => {
      const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
      const events = JSON.parse(fs.readFileSync(eventsPath, "utf8")) as Array<{
        reason: string;
      }>;
      const reasons = events.map((e) => e.reason);
      expect(reasons).toContain("ErrImagePull");
      expect(reasons).toContain("Failed");
    });

    it("logs directory exists (minimal/empty logs — pod never started)", () => {
      const logsDir = path.join(dir, "logs");
      expect(exists(logsDir)).toBe(true);
    });
  });
});

describe("createTestBundle helper", () => {
  let tmpDir: string;
  let bundlePath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbi-test-bundle-"));
    bundlePath = path.join(tmpDir, "test-bundle.tar.gz");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces a .tar.gz from wrong-db-endpoint scenario", async () => {
    const scenarioDir = getFixturePath("wrong-db-endpoint");
    const result = await createTestBundle(scenarioDir, bundlePath);
    expect(result).toBe(bundlePath);
    expect(exists(bundlePath)).toBe(true);
    const stat = fs.statSync(bundlePath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("tar.gz can be extracted and re-read", async () => {
    const extractDir = path.join(tmpDir, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });

    await tar.x({
      file: bundlePath,
      cwd: extractDir,
    });

    const versionPath = path.join(extractDir, "wrong-db-endpoint", "version.yaml");
    expect(exists(versionPath)).toBe(true);
    const content = fs.readFileSync(versionPath, "utf8");
    expect(content).toContain("SupportBundle");
  });

  it("createTestBundle also works with missing-secret-crashloop scenario", async () => {
    const scenarioDir = getFixturePath("missing-secret-crashloop");
    const outPath = path.join(tmpDir, "missing-secret-crashloop.tar.gz");
    const result = await createTestBundle(scenarioDir, outPath);
    expect(exists(result)).toBe(true);
  });

  it("createTestBundle also works with bad-image-tag scenario", async () => {
    const scenarioDir = getFixturePath("bad-image-tag");
    const outPath = path.join(tmpDir, "bad-image-tag.tar.gz");
    const result = await createTestBundle(scenarioDir, outPath);
    expect(exists(result)).toBe(true);
  });

  it("creates parent directories for the output archive path", async () => {
    const scenarioDir = getFixturePath("wrong-db-endpoint");
    const outPath = path.join(tmpDir, "nested", "artifacts", "bundle.tar.gz");

    const result = await createTestBundle(scenarioDir, outPath);

    expect(result).toBe(outPath);
    expect(exists(outPath)).toBe(true);
  });

  it("throws a clear error when the scenario directory does not exist", async () => {
    const missingDir = path.join(tmpDir, "does-not-exist");
    const outPath = path.join(tmpDir, "missing.tar.gz");

    await expect(createTestBundle(missingDir, outPath)).rejects.toThrow(
      /Scenario directory does not exist/
    );
  });
});
