import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as tar from "tar";
import { createTestBundle, getFixturePath } from "../../helpers/create-test-bundle";
import { parseResourceJson } from "../../../src/parsers/k8s-resource-parser.js";
import { parseEventsJson } from "../../../src/parsers/event-parser.js";
import { parseAnalyzerJson } from "../../../src/parsers/analyzer-parser.js";
import { parseLogFile } from "../../../src/parsers/log-parser.js";
import { parseHelmReleaseContent } from "../../../src/parsers/helm-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exists(p: string): boolean {
  return fs.existsSync(p);
}

/**
 * Parses a JSON file containing a Kubernetes List resource and returns the
 * items array typed as T[].
 */
function parseListFile<T>(filePath: string): T[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as { kind: string; items: T[] };
  return parsed.items;
}

/**
 * Parses an EventList JSON file and returns the items array.
 */
function parseEventListFile(filePath: string): Array<{
  type: string;
  reason: string;
  message: string;
  involvedObject: { kind: string; name: string };
}> {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as {
    kind: string;
    items: Array<{
      type: string;
      reason: string;
      message: string;
      involvedObject: { kind: string; name: string };
    }>;
  };
  return parsed.items;
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

    it("has analysis.json at scenario root", () => {
      expect(exists(path.join(dir, "analysis.json"))).toBe(true);
    });

    it("analysis.json contains a warn severity entry", () => {
      const raw = fs.readFileSync(path.join(dir, "analysis.json"), "utf8");
      const data = JSON.parse(raw) as Array<{
        name: string;
        insight: { severity: string; primary: string; detail: string };
      }>;
      expect(Array.isArray(data)).toBe(true);
      const warn = data.find((e) => e.insight.severity === "warn");
      expect(warn).toBeDefined();
    });

    it("has flat PodList JSON in cluster-resources/pods/default.json", () => {
      const podListPath = path.join(dir, "cluster-resources", "pods", "default.json");
      expect(exists(podListPath)).toBe(true);
      const raw = fs.readFileSync(podListPath, "utf8");
      const parsed = JSON.parse(raw) as { kind: string; items: unknown[] };
      expect(parsed.kind).toBe("PodList");
      expect(Array.isArray(parsed.items)).toBe(true);
      expect(parsed.items.length).toBeGreaterThan(0);
    });

    it("PodList JSON shows pod with Running phase and Ready=False", () => {
      const pods = parseListFile<{
        kind: string;
        metadata: { name: string; namespace: string };
        status: {
          phase: string;
          conditions: Array<{ type: string; status: string }>;
        };
      }>(path.join(dir, "cluster-resources", "pods", "default.json"));

      const pod = pods.find((p) => p.metadata.name === "app-pod");
      expect(pod).toBeDefined();
      expect(pod!.kind).toBe("Pod");
      expect(pod!.metadata.namespace).toBe("default");
      expect(pod!.status.phase).toBe("Running");

      const readyCond = pod!.status.conditions.find((c) => c.type === "Ready");
      expect(readyCond).toBeDefined();
      expect(readyCond!.status).toBe("False");
    });

    it("has flat ServiceList JSON in cluster-resources/services/default.json (no db service)", () => {
      const svcListPath = path.join(dir, "cluster-resources", "services", "default.json");
      expect(exists(svcListPath)).toBe(true);
      const raw = fs.readFileSync(svcListPath, "utf8");
      const parsed = JSON.parse(raw) as { kind: string; items: unknown[] };
      expect(parsed.kind).toBe("ServiceList");
      expect(parsed.items.length).toBeGreaterThan(0);
      // None of the items should be a db service
      const content = raw.toLowerCase();
      expect(content).not.toContain('"name": "db-service"');
    });

    it("ServiceList JSON contains app-service with correct fields", () => {
      const services = parseListFile<{
        kind: string;
        metadata: { name: string; namespace: string };
      }>(path.join(dir, "cluster-resources", "services", "default.json"));

      const svc = services.find((s) => s.metadata.name === "app-service");
      expect(svc).toBeDefined();
      expect(svc!.kind).toBe("Service");
      expect(svc!.metadata.namespace).toBe("default");
    });

    it("has events JSON wrapped in EventList with connection-related warnings", () => {
      const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
      expect(exists(eventsPath)).toBe(true);
      const raw = fs.readFileSync(eventsPath, "utf8");
      const parsed = JSON.parse(raw) as { kind: string; items: unknown[] };
      expect(parsed.kind).toBe("EventList");
      expect(Array.isArray(parsed.items)).toBe(true);
      const events = parseEventListFile(eventsPath);
      const warnings = events.filter((e) => e.type === "Warning");
      expect(warnings.length).toBeGreaterThan(0);
    });

    it("has pod log at cluster-resources/pods/logs/default/app-pod/app.log with DNS lookup error", () => {
      const logPath = path.join(
        dir,
        "cluster-resources",
        "pods",
        "logs",
        "default",
        "app-pod",
        "app.log",
      );
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

    it("has analysis.json at scenario root with error severity", () => {
      const raw = fs.readFileSync(path.join(dir, "analysis.json"), "utf8");
      const data = JSON.parse(raw) as Array<{
        name: string;
        insight: { severity: string; primary: string; detail: string };
      }>;
      expect(Array.isArray(data)).toBe(true);
      const error = data.find((e) => e.insight.severity === "error");
      expect(error).toBeDefined();
    });

    it("PodList JSON shows CrashLoopBackOff with restartCount 8", () => {
      const podListPath = path.join(dir, "cluster-resources", "pods", "default.json");
      expect(exists(podListPath)).toBe(true);
      const pods = parseListFile<{
        metadata: { name: string };
        status: {
          containerStatuses: Array<{
            restartCount: number;
            state: { waiting?: { reason: string } };
          }>;
        };
      }>(podListPath);

      const pod = pods.find((p) => p.metadata.name === "app-pod");
      expect(pod).toBeDefined();

      const cs = pod!.status.containerStatuses[0]!;
      expect(cs.restartCount).toBe(8);
      expect(cs.state.waiting?.reason).toBe("CrashLoopBackOff");
    });

    it("DeploymentList JSON references app-credentials secret", () => {
      const depListPath = path.join(dir, "cluster-resources", "deployments", "default.json");
      expect(exists(depListPath)).toBe(true);
      const raw = fs.readFileSync(depListPath, "utf8");
      const parsed = JSON.parse(raw) as { kind: string; items: unknown[] };
      expect(parsed.kind).toBe("DeploymentList");
      expect(parsed.items.length).toBeGreaterThan(0);
      expect(raw).toContain("app-credentials");
    });

    it("DeploymentList JSON contains app-deployment with correct fields", () => {
      const deployments = parseListFile<{
        kind: string;
        metadata: { name: string; namespace: string };
      }>(path.join(dir, "cluster-resources", "deployments", "default.json"));

      const dep = deployments.find((d) => d.metadata.name === "app-deployment");
      expect(dep).toBeDefined();
      expect(dep!.kind).toBe("Deployment");
      expect(dep!.metadata.namespace).toBe("default");
    });

    it("SecretList JSON does NOT contain app-credentials", () => {
      const secretListPath = path.join(dir, "cluster-resources", "secrets", "default.json");
      expect(exists(secretListPath)).toBe(true);
      const secrets = parseListFile<{ metadata: { name: string } }>(secretListPath);
      const hasAppCreds = secrets.some((s) => s.metadata.name === "app-credentials");
      expect(hasAppCreds).toBe(false);
    });

    it("SecretList JSON contains other-secret as a valid Secret", () => {
      const secrets = parseListFile<{
        kind: string;
        metadata: { name: string; namespace: string };
      }>(path.join(dir, "cluster-resources", "secrets", "default.json"));

      const secret = secrets.find((s) => s.metadata.name === "other-secret");
      expect(secret).toBeDefined();
      expect(secret!.kind).toBe("Secret");
      expect(secret!.metadata.namespace).toBe("default");
    });

    it("events include FailedMount and BackOff events in EventList", () => {
      const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
      const events = parseEventListFile(eventsPath);
      const reasons = events.map((e) => e.reason);
      expect(reasons).toContain("FailedMount");
      expect(reasons).toContain("BackOff");
    });

    it("pod log at cluster-resources/pods/logs/default/app-pod/app.log contains secret-not-found error", () => {
      const logPath = path.join(
        dir,
        "cluster-resources",
        "pods",
        "logs",
        "default",
        "app-pod",
        "app.log",
      );
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

    it("has analysis.json at scenario root with error severity", () => {
      const raw = fs.readFileSync(path.join(dir, "analysis.json"), "utf8");
      const data = JSON.parse(raw) as Array<{
        name: string;
        insight: { severity: string; primary: string; detail: string };
      }>;
      expect(Array.isArray(data)).toBe(true);
      const error = data.find((e) => e.insight.severity === "error");
      expect(error).toBeDefined();
    });

    it("PodList JSON shows ImagePullBackOff waiting state", () => {
      const podListPath = path.join(dir, "cluster-resources", "pods", "default.json");
      expect(exists(podListPath)).toBe(true);
      const raw = fs.readFileSync(podListPath, "utf8");
      expect(raw).toContain("ImagePullBackOff");
    });

    it("DeploymentList JSON references invalid image tag v999.99.99", () => {
      const depListPath = path.join(dir, "cluster-resources", "deployments", "default.json");
      expect(exists(depListPath)).toBe(true);
      const raw = fs.readFileSync(depListPath, "utf8");
      const parsed = JSON.parse(raw) as { kind: string; items: unknown[] };
      expect(parsed.kind).toBe("DeploymentList");
      expect(parsed.items.length).toBeGreaterThan(0);
      expect(raw).toContain("myapp:v999.99.99");
    });

    it("DeploymentList JSON contains app-deployment with correct fields", () => {
      const deployments = parseListFile<{
        kind: string;
        metadata: { name: string; namespace: string };
      }>(path.join(dir, "cluster-resources", "deployments", "default.json"));

      const dep = deployments.find((d) => d.metadata.name === "app-deployment");
      expect(dep).toBeDefined();
      expect(dep!.kind).toBe("Deployment");
      expect(dep!.metadata.namespace).toBe("default");
    });

    it("events include ErrImagePull and Failed reasons in EventList", () => {
      const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
      const events = parseEventListFile(eventsPath);
      const reasons = events.map((e) => e.reason);
      expect(reasons).toContain("ErrImagePull");
      expect(reasons).toContain("Failed");
    });

    it("pod log exists at cluster-resources/pods/logs/default/app-pod/app.log", () => {
      const logPath = path.join(
        dir,
        "cluster-resources",
        "pods",
        "logs",
        "default",
        "app-pod",
        "app.log",
      );
      expect(exists(logPath)).toBe(true);
    });
  });

  describe("Scenario 4: pvc-pending", () => {
    const dir = getFixturePath("pvc-pending");

    it("fixture directory exists", () => {
      expect(exists(dir)).toBe(true);
    });

    it("has version.yaml", () => {
      expect(exists(path.join(dir, "version.yaml"))).toBe(true);
    });

    it("has analysis.json at scenario root with error severity", () => {
      const raw = fs.readFileSync(path.join(dir, "analysis.json"), "utf8");
      const data = JSON.parse(raw) as Array<{
        name: string;
        insight: { severity: string; primary: string; detail: string };
      }>;
      expect(Array.isArray(data)).toBe(true);
      const error = data.find((e) => e.insight.severity === "error");
      expect(error).toBeDefined();
    });

    it("PodList JSON shows db-pod in Pending phase with ContainerCreating", () => {
      const podListPath = path.join(dir, "cluster-resources", "pods", "default.json");
      expect(exists(podListPath)).toBe(true);
      const pods = parseListFile<{
        metadata: { name: string };
        status: {
          phase: string;
          containerStatuses: Array<{
            state: { waiting?: { reason: string } };
          }>;
        };
      }>(podListPath);

      const pod = pods.find((p) => p.metadata.name === "db-pod");
      expect(pod).toBeDefined();
      expect(pod!.status.phase).toBe("Pending");
      expect(pod!.status.containerStatuses[0]!.state.waiting?.reason).toBe(
        "ContainerCreating",
      );
    });

    it("DeploymentList JSON references data-pvc", () => {
      const depListPath = path.join(dir, "cluster-resources", "deployments", "default.json");
      expect(exists(depListPath)).toBe(true);
      const raw = fs.readFileSync(depListPath, "utf8");
      const parsed = JSON.parse(raw) as { kind: string; items: unknown[] };
      expect(parsed.kind).toBe("DeploymentList");
      expect(raw).toContain("data-pvc");
    });

    it("PersistentVolumeClaimList JSON shows data-pvc in Pending phase referencing fast-ssd", () => {
      const pvcListPath = path.join(
        dir,
        "cluster-resources",
        "persistentvolumeclaims",
        "default.json",
      );
      expect(exists(pvcListPath)).toBe(true);
      const pvcs = parseListFile<{
        metadata: { name: string };
        spec: { storageClassName: string };
        status: { phase: string };
      }>(pvcListPath);

      const pvc = pvcs.find((p) => p.metadata.name === "data-pvc");
      expect(pvc).toBeDefined();
      expect(pvc!.status.phase).toBe("Pending");
      expect(pvc!.spec.storageClassName).toBe("fast-ssd");
    });

    it("StorageClassList JSON only has standard (no fast-ssd)", () => {
      const scListPath = path.join(
        dir,
        "cluster-resources",
        "storageclasses",
        "storageclasses.json",
      );
      expect(exists(scListPath)).toBe(true);
      const scs = parseListFile<{ metadata: { name: string } }>(scListPath);
      const hasFastSsd = scs.some((s) => s.metadata.name === "fast-ssd");
      expect(hasFastSsd).toBe(false);
      const hasStandard = scs.some((s) => s.metadata.name === "standard");
      expect(hasStandard).toBe(true);
    });

    it("events include ProvisioningFailed and FailedMount in EventList", () => {
      const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
      const events = parseEventListFile(eventsPath);
      const reasons = events.map((e) => e.reason);
      expect(reasons).toContain("ProvisioningFailed");
      expect(reasons).toContain("FailedMount");
    });

    it("pod log at cluster-resources/pods/logs/default/db-pod/postgres.log contains volume error", () => {
      const logPath = path.join(
        dir,
        "cluster-resources",
        "pods",
        "logs",
        "default",
        "db-pod",
        "postgres.log",
      );
      expect(exists(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf8");
      expect(content).toContain("PersistentVolumeClaim");
    });

    it("has cluster_version.json", () => {
      expect(exists(path.join(dir, "cluster-info", "cluster_version.json"))).toBe(true);
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
      /Scenario directory does not exist/,
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: multi-namespace-retrieval
// ---------------------------------------------------------------------------

describe("Scenario 5: multi-namespace-retrieval", () => {
  const dir = getFixturePath("multi-namespace-retrieval");

  // ---------------------------------------------------------------------------
  // Directory structure
  // ---------------------------------------------------------------------------

  it("fixture directory exists", () => {
    expect(exists(dir)).toBe(true);
  });

  it("has version.yaml with SupportBundle kind", () => {
    const versionPath = path.join(dir, "version.yaml");
    expect(exists(versionPath)).toBe(true);
    const content = fs.readFileSync(versionPath, "utf8");
    expect(content).toContain("SupportBundle");
  });

  it("has cluster_version.json", () => {
    expect(exists(path.join(dir, "cluster-info", "cluster_version.json"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // analysis.json — parses with parseAnalyzerJson
  // ---------------------------------------------------------------------------

  it("analysis.json exists and contains error severity entries", () => {
    const analysisPath = path.join(dir, "analysis.json");
    expect(exists(analysisPath)).toBe(true);
    const raw = fs.readFileSync(analysisPath, "utf8");
    const results = parseAnalyzerJson(raw);
    expect(Array.isArray(results)).toBe(true);
    const errors = results.filter((r) => r.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("analysis.json contains pass entries for healthy resources", () => {
    const raw = fs.readFileSync(path.join(dir, "analysis.json"), "utf8");
    const results = parseAnalyzerJson(raw);
    const passing = results.filter((r) => r.severity === "pass");
    expect(passing.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Pods — parsed with parseResourceJson across 3 namespaces
  // ---------------------------------------------------------------------------

  it("PodList for default namespace parses and contains web-app-pod (unhealthy) and cache-pod (healthy)", () => {
    const podListPath = path.join(dir, "cluster-resources", "pods", "default.json");
    expect(exists(podListPath)).toBe(true);
    const raw = fs.readFileSync(podListPath, "utf8");
    const pods = parseResourceJson(raw);
    expect(pods.length).toBe(2);

    const webAppPod = pods.find((p) => p.metadata.name === "web-app-pod");
    expect(webAppPod).toBeDefined();
    expect(webAppPod!.kind).toBe("Pod");
    expect(webAppPod!.metadata.namespace).toBe("default");

    const cachePod = pods.find((p) => p.metadata.name === "cache-pod");
    expect(cachePod).toBeDefined();
    expect(cachePod!.kind).toBe("Pod");
  });

  it("web-app-pod is Running but not Ready", () => {
    const pods = parseListFile<{
      metadata: { name: string };
      status: { phase: string; conditions: Array<{ type: string; status: string }> };
    }>(path.join(dir, "cluster-resources", "pods", "default.json"));

    const pod = pods.find((p) => p.metadata.name === "web-app-pod");
    expect(pod).toBeDefined();
    expect(pod!.status.phase).toBe("Running");
    const readyCond = pod!.status.conditions.find((c) => c.type === "Ready");
    expect(readyCond).toBeDefined();
    expect(readyCond!.status).toBe("False");
  });

  it("cache-pod is Running and Ready", () => {
    const pods = parseListFile<{
      metadata: { name: string };
      status: { phase: string; conditions: Array<{ type: string; status: string }> };
    }>(path.join(dir, "cluster-resources", "pods", "default.json"));

    const pod = pods.find((p) => p.metadata.name === "cache-pod");
    expect(pod).toBeDefined();
    expect(pod!.status.phase).toBe("Running");
    const readyCond = pod!.status.conditions.find((c) => c.type === "Ready");
    expect(readyCond).toBeDefined();
    expect(readyCond!.status).toBe("True");
  });

  it("PodList for database namespace parses and contains 3 pods", () => {
    const podListPath = path.join(dir, "cluster-resources", "pods", "database.json");
    expect(exists(podListPath)).toBe(true);
    const raw = fs.readFileSync(podListPath, "utf8");
    const pods = parseResourceJson(raw);
    expect(pods.length).toBe(3);

    const names = pods.map((p) => p.metadata.name);
    expect(names).toContain("postgres-primary-pod");
    expect(names).toContain("postgres-replica-pod");
    expect(names).toContain("migration-pod");
  });

  it("postgres-primary-pod is Running but not Ready", () => {
    const pods = parseListFile<{
      metadata: { name: string };
      status: { phase: string; conditions: Array<{ type: string; status: string }> };
    }>(path.join(dir, "cluster-resources", "pods", "database.json"));

    const pod = pods.find((p) => p.metadata.name === "postgres-primary-pod");
    expect(pod).toBeDefined();
    expect(pod!.status.phase).toBe("Running");
    const readyCond = pod!.status.conditions.find((c) => c.type === "Ready");
    expect(readyCond!.status).toBe("False");
  });

  it("postgres-replica-pod is Running and Ready (healthy reference)", () => {
    const pods = parseListFile<{
      metadata: { name: string };
      status: { phase: string; conditions: Array<{ type: string; status: string }> };
    }>(path.join(dir, "cluster-resources", "pods", "database.json"));

    const pod = pods.find((p) => p.metadata.name === "postgres-replica-pod");
    expect(pod).toBeDefined();
    expect(pod!.status.phase).toBe("Running");
    const readyCond = pod!.status.conditions.find((c) => c.type === "Ready");
    expect(readyCond!.status).toBe("True");
  });

  it("PodList for monitoring namespace parses and contains 3 pods", () => {
    const podListPath = path.join(dir, "cluster-resources", "pods", "monitoring.json");
    expect(exists(podListPath)).toBe(true);
    const raw = fs.readFileSync(podListPath, "utf8");
    const pods = parseResourceJson(raw);
    expect(pods.length).toBe(3);

    const names = pods.map((p) => p.metadata.name);
    expect(names).toContain("prometheus-pod");
    expect(names).toContain("grafana-pod");
    expect(names).toContain("alertmanager-pod");
  });

  it("alertmanager-pod has OOMKilled in lastState", () => {
    const raw = fs.readFileSync(
      path.join(dir, "cluster-resources", "pods", "monitoring.json"),
      "utf8",
    );
    expect(raw).toContain("OOMKilled");
  });

  // ---------------------------------------------------------------------------
  // Deployments — 4 across 3 namespaces
  // ---------------------------------------------------------------------------

  it("DeploymentList for default namespace contains web-app deployment", () => {
    const depListPath = path.join(dir, "cluster-resources", "deployments", "default.json");
    const deployments = parseResourceJson(fs.readFileSync(depListPath, "utf8"));
    expect(deployments.length).toBe(1);
    expect(deployments[0]!.metadata.name).toBe("web-app");
    expect(deployments[0]!.kind).toBe("Deployment");
  });

  it("DeploymentList for database namespace contains postgres deployment", () => {
    const depListPath = path.join(dir, "cluster-resources", "deployments", "database.json");
    const deployments = parseResourceJson(fs.readFileSync(depListPath, "utf8"));
    expect(deployments.length).toBe(1);
    expect(deployments[0]!.metadata.name).toBe("postgres");
  });

  it("DeploymentList for monitoring namespace contains grafana and alertmanager", () => {
    const depListPath = path.join(dir, "cluster-resources", "deployments", "monitoring.json");
    const deployments = parseResourceJson(fs.readFileSync(depListPath, "utf8"));
    expect(deployments.length).toBe(2);
    const names = deployments.map((d) => d.metadata.name);
    expect(names).toContain("grafana");
    expect(names).toContain("alertmanager");
  });

  // ---------------------------------------------------------------------------
  // Services — 3 (one per namespace)
  // ---------------------------------------------------------------------------

  it("ServiceList for each namespace parses correctly", () => {
    const namespaces = ["default", "database", "monitoring"];
    const expectedServiceNames = ["web-app-service", "postgres-service", "grafana-service"];

    for (let i = 0; i < namespaces.length; i++) {
      const ns = namespaces[i]!;
      const svcPath = path.join(dir, "cluster-resources", "services", `${ns}.json`);
      expect(exists(svcPath)).toBe(true);
      const services = parseResourceJson(fs.readFileSync(svcPath, "utf8"));
      expect(services.length).toBeGreaterThanOrEqual(1);
      const names = services.map((s) => s.metadata.name);
      expect(names).toContain(expectedServiceNames[i]);
    }
  });

  // ---------------------------------------------------------------------------
  // ConfigMaps — key diagnostic signal: db-config has wrong-host.internal
  // ---------------------------------------------------------------------------

  it("ConfigMapList for database namespace parses and contains db-config", () => {
    const cmPath = path.join(dir, "cluster-resources", "configmaps", "database.json");
    expect(exists(cmPath)).toBe(true);
    const configMaps = parseResourceJson(fs.readFileSync(cmPath, "utf8"));
    const dbConfig = configMaps.find((cm) => cm.metadata.name === "db-config");
    expect(dbConfig).toBeDefined();
    expect(dbConfig!.kind).toBe("ConfigMap");
    expect(dbConfig!.metadata.namespace).toBe("database");
  });

  it("db-config ConfigMap contains DB_HOST: wrong-host.internal (key diagnostic signal)", () => {
    const raw = fs.readFileSync(
      path.join(dir, "cluster-resources", "configmaps", "database.json"),
      "utf8",
    );
    expect(raw).toContain("wrong-host.internal");
    expect(raw).toContain("DB_HOST");
  });

  it("ConfigMapList for default namespace parses correctly", () => {
    const cmPath = path.join(dir, "cluster-resources", "configmaps", "default.json");
    const configMaps = parseResourceJson(fs.readFileSync(cmPath, "utf8"));
    expect(configMaps.length).toBe(1);
    expect(configMaps[0]!.metadata.name).toBe("web-app-config");
  });

  it("ConfigMapList for monitoring namespace contains prometheus-config", () => {
    const cmPath = path.join(dir, "cluster-resources", "configmaps", "monitoring.json");
    const configMaps = parseResourceJson(fs.readFileSync(cmPath, "utf8"));
    const promConfig = configMaps.find((cm) => cm.metadata.name === "prometheus-config");
    expect(promConfig).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Secrets — 3 (one per namespace)
  // ---------------------------------------------------------------------------

  it("SecretList for each namespace parses correctly", () => {
    const namespaces = ["default", "database", "monitoring"];
    for (const ns of namespaces) {
      const secretPath = path.join(dir, "cluster-resources", "secrets", `${ns}.json`);
      expect(exists(secretPath)).toBe(true);
      const secrets = parseResourceJson(fs.readFileSync(secretPath, "utf8"));
      expect(secrets.length).toBeGreaterThanOrEqual(1);
      expect(secrets.every((s) => s.kind === "Secret")).toBe(true);
    }
  });

  it("postgres-auth-secret exists in database namespace", () => {
    const secrets = parseListFile<{ metadata: { name: string; namespace: string } }>(
      path.join(dir, "cluster-resources", "secrets", "database.json"),
    );
    const authSecret = secrets.find((s) => s.metadata.name === "postgres-auth-secret");
    expect(authSecret).toBeDefined();
    expect(authSecret!.metadata.namespace).toBe("database");
  });

  // ---------------------------------------------------------------------------
  // PersistentVolumeClaims — 2 (database + monitoring)
  // ---------------------------------------------------------------------------

  it("PersistentVolumeClaimList for database namespace contains postgres-data-pvc (Bound)", () => {
    const pvcPath = path.join(dir, "cluster-resources", "persistentvolumeclaims", "database.json");
    expect(exists(pvcPath)).toBe(true);
    const pvcs = parseListFile<{
      metadata: { name: string };
      status: { phase: string };
    }>(pvcPath);
    const pvc = pvcs.find((p) => p.metadata.name === "postgres-data-pvc");
    expect(pvc).toBeDefined();
    expect(pvc!.status.phase).toBe("Bound");
  });

  it("PersistentVolumeClaimList for monitoring namespace contains prometheus-data-pvc (Bound)", () => {
    const pvcPath = path.join(dir, "cluster-resources", "persistentvolumeclaims", "monitoring.json");
    expect(exists(pvcPath)).toBe(true);
    const pvcs = parseListFile<{
      metadata: { name: string };
      status: { phase: string };
    }>(pvcPath);
    const pvc = pvcs.find((p) => p.metadata.name === "prometheus-data-pvc");
    expect(pvc).toBeDefined();
    expect(pvc!.status.phase).toBe("Bound");
  });

  // ---------------------------------------------------------------------------
  // Events — ~50 across 3 namespaces parsed with parseEventsJson
  // ---------------------------------------------------------------------------

  it("EventList for default namespace parses with parseEventsJson and has Warning events", () => {
    const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
    expect(exists(eventsPath)).toBe(true);
    const raw = fs.readFileSync(eventsPath, "utf8");
    const events = parseEventsJson(raw);
    expect(events.length).toBeGreaterThanOrEqual(10);
    const warnings = events.filter((e) => e.type === "Warning");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("default namespace events include BackOff, Unhealthy, and Failed reasons", () => {
    const events = parseEventsJson(
      fs.readFileSync(path.join(dir, "cluster-resources", "events", "default.json"), "utf8"),
    );
    const reasons = events.map((e) => e.reason);
    expect(reasons).toContain("BackOff");
    expect(reasons).toContain("Unhealthy");
    expect(reasons).toContain("Failed");
  });

  it("default namespace events include Pulled and Started reasons (healthy signals)", () => {
    const events = parseEventsJson(
      fs.readFileSync(path.join(dir, "cluster-resources", "events", "default.json"), "utf8"),
    );
    const reasons = events.map((e) => e.reason);
    expect(reasons).toContain("Pulled");
    expect(reasons).toContain("Started");
  });

  it("database namespace events include FailedMount, BackOff, and Unhealthy reasons", () => {
    const events = parseEventsJson(
      fs.readFileSync(path.join(dir, "cluster-resources", "events", "database.json"), "utf8"),
    );
    const reasons = events.map((e) => e.reason);
    expect(reasons).toContain("FailedMount");
    expect(reasons).toContain("BackOff");
    expect(reasons).toContain("Unhealthy");
  });

  it("monitoring namespace events include OOMKilling, BackOff, and Unhealthy reasons", () => {
    const events = parseEventsJson(
      fs.readFileSync(path.join(dir, "cluster-resources", "events", "monitoring.json"), "utf8"),
    );
    const reasons = events.map((e) => e.reason);
    expect(reasons).toContain("OOMKilling");
    expect(reasons).toContain("BackOff");
    expect(reasons).toContain("Unhealthy");
  });

  it("total event count across all namespaces is approximately 50", () => {
    const namespaces = ["default", "database", "monitoring"];
    let totalEvents = 0;
    for (const ns of namespaces) {
      const eventsPath = path.join(dir, "cluster-resources", "events", `${ns}.json`);
      const events = parseEventsJson(fs.readFileSync(eventsPath, "utf8"));
      totalEvents += events.length;
    }
    expect(totalEvents).toBeGreaterThanOrEqual(45);
    expect(totalEvents).toBeLessThanOrEqual(60);
  });

  // ---------------------------------------------------------------------------
  // Log files — parsed with parseLogFile, checking diagnostic signals
  // ---------------------------------------------------------------------------

  it("web-app-pod log exists and contains DNS error for wrong-host.internal", async () => {
    const logPath = path.join(
      dir,
      "cluster-resources",
      "pods",
      "logs",
      "default",
      "web-app-pod",
      "app.log",
    );
    expect(exists(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("wrong-host.internal");
    expect(content).toContain("no such host");

    const logFile = await parseLogFile(logPath);
    expect(logFile.lines.length).toBeGreaterThan(0);
    expect(logFile.errorCount).toBeGreaterThan(0);
    expect(logFile.importance).toBeGreaterThan(0);
  });

  it("web-app-pod log links DB_HOST to wrong-host.internal (ConfigMap cross-reference)", () => {
    const logPath = path.join(
      dir,
      "cluster-resources",
      "pods",
      "logs",
      "default",
      "web-app-pod",
      "app.log",
    );
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("DB_HOST=wrong-host.internal");
  });

  it("postgres-primary-pod log exists and contains authentication failure pattern", async () => {
    const logPath = path.join(
      dir,
      "cluster-resources",
      "pods",
      "logs",
      "database",
      "postgres-primary-pod",
      "postgres.log",
    );
    expect(exists(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("password authentication failed for user");
    expect(content).toContain("postgres-auth-secret");

    const logFile = await parseLogFile(logPath);
    expect(logFile.errorCount).toBeGreaterThan(0);
  });

  it("alertmanager-pod log exists and contains OOM patterns", async () => {
    const logPath = path.join(
      dir,
      "cluster-resources",
      "pods",
      "logs",
      "monitoring",
      "alertmanager-pod",
      "alertmanager.log",
    );
    expect(exists(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("OOMKilled");
    expect(content).toContain("memory limit");

    const logFile = await parseLogFile(logPath);
    expect(logFile.errorCount).toBeGreaterThan(0);
    expect(logFile.importance).toBeGreaterThan(0.5);
  });

  it("prometheus-pod log exists and is healthy (no errors)", async () => {
    const logPath = path.join(
      dir,
      "cluster-resources",
      "pods",
      "logs",
      "monitoring",
      "prometheus-pod",
      "prometheus.log",
    );
    expect(exists(logPath)).toBe(true);
    const logFile = await parseLogFile(logPath);
    expect(logFile.lines.length).toBeGreaterThan(0);
    expect(logFile.errorCount).toBe(0);
  });

  it("grafana-pod log exists and contains DNS errors for wrong-host.internal", async () => {
    const logPath = path.join(
      dir,
      "cluster-resources",
      "pods",
      "logs",
      "monitoring",
      "grafana-pod",
      "grafana.log",
    );
    expect(exists(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("wrong-host.internal");
    expect(content).toContain("no such host");

    const logFile = await parseLogFile(logPath);
    expect(logFile.errorCount).toBeGreaterThan(0);
  });

  it("total log line count across all log files is approximately 200", async () => {
    const logFiles = [
      path.join(dir, "cluster-resources", "pods", "logs", "default", "web-app-pod", "app.log"),
      path.join(dir, "cluster-resources", "pods", "logs", "database", "postgres-primary-pod", "postgres.log"),
      path.join(dir, "cluster-resources", "pods", "logs", "database", "migration-pod", "migrate.log"),
      path.join(dir, "cluster-resources", "pods", "logs", "monitoring", "alertmanager-pod", "alertmanager.log"),
      path.join(dir, "cluster-resources", "pods", "logs", "monitoring", "grafana-pod", "grafana.log"),
      path.join(dir, "cluster-resources", "pods", "logs", "monitoring", "prometheus-pod", "prometheus.log"),
    ];
    let totalLines = 0;
    for (const logPath of logFiles) {
      const logFile = await parseLogFile(logPath);
      totalLines += logFile.lines.length;
    }
    expect(totalLines).toBeGreaterThanOrEqual(150);
    expect(totalLines).toBeLessThanOrEqual(300);
  });

  // ---------------------------------------------------------------------------
  // Fixture can be packed into a .tar.gz bundle
  // ---------------------------------------------------------------------------

  it("createTestBundle works with multi-namespace-retrieval scenario", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbi-mnr-"));
    const outPath = path.join(tmpDir, "multi-namespace-retrieval.tar.gz");
    try {
      const result = await createTestBundle(dir, outPath);
      expect(exists(result)).toBe(true);
      const stat = fs.statSync(result);
      expect(stat.size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

  // ---------------------------------------------------------------------------
  // Scenario 6: network-policy-deny
  // ---------------------------------------------------------------------------

  describe("Scenario 6: network-policy-deny", () => {
    const dir = getFixturePath("network-policy-deny");

    it("fixture directory exists", () => {
      expect(exists(dir)).toBe(true);
    });

    it("has version.yaml with SupportBundle kind", () => {
      const versionPath = path.join(dir, "version.yaml");
      expect(exists(versionPath)).toBe(true);
      const content = fs.readFileSync(versionPath, "utf8");
      expect(content).toContain("SupportBundle");
    });

    it("has cluster_version.json", () => {
      expect(exists(path.join(dir, "cluster-info", "cluster_version.json"))).toBe(true);
    });

    it("analysis.json contains a connectivity warning and a healthy service pass", () => {
      const raw = fs.readFileSync(path.join(dir, "analysis.json"), "utf8");
      const results = parseAnalyzerJson(raw);
      expect(results.some((r) => r.severity === "warn")).toBe(true);
      expect(results.some((r) => r.severity === "pass")).toBe(true);
      expect(raw).toContain("blocked");
      expect(raw).toContain("payments-api");
    });

    it("contains a deny-all egress NetworkPolicy that targets api-client pods", () => {
      const policyPath = path.join(
        dir,
        "cluster-resources",
        "networkpolicies",
        "default",
        "deny-all-egress.yaml",
      );
      expect(exists(policyPath)).toBe(true);
      const raw = fs.readFileSync(policyPath, "utf8");
      expect(raw).toContain("kind: NetworkPolicy");
      expect(raw).toContain("name: deny-all-egress");
      expect(raw).toContain("- Egress");
      expect(raw).toContain("egress: []");
      expect(raw).toContain("app: api-client");
    });

    it("contains api-client pod YAML with labels matching the NetworkPolicy", () => {
      const podPath = path.join(
        dir,
        "cluster-resources",
        "pods",
        "default",
        "api-client-pod.yaml",
      );
      expect(exists(podPath)).toBe(true);
      const raw = fs.readFileSync(podPath, "utf8");
      expect(raw).toContain("name: api-client-pod");
      expect(raw).toContain("namespace: default");
      expect(raw).toContain("app: api-client");
      expect(raw).toContain("Ready");
      expect(raw).toContain("status: \"False\"");
    });

    it("includes a healthy payments service and endpoint manifest", () => {
      const servicePath = path.join(
        dir,
        "cluster-resources",
        "services",
        "default",
        "payments-api.yaml",
      );
      const endpointPath = path.join(
        dir,
        "cluster-resources",
        "endpoints",
        "default",
        "payments-api.yaml",
      );
      expect(exists(servicePath)).toBe(true);
      expect(exists(endpointPath)).toBe(true);
      expect(fs.readFileSync(servicePath, "utf8")).toContain("name: payments-api");
      const endpointRaw = fs.readFileSync(endpointPath, "utf8");
      expect(endpointRaw).toContain("addresses:");
      expect(endpointRaw).toContain("10.244.2.40");
    });

    it("events include connection timeout failures for api-client-pod", () => {
      const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
      expect(exists(eventsPath)).toBe(true);
      const events = parseEventsJson(fs.readFileSync(eventsPath, "utf8"));
      expect(events.some((e) => e.reason === "Unhealthy")).toBe(true);
      expect(events.some((e) => e.message.includes("timed out"))).toBe(true);
      expect(events.some((e) => e.involvedObject.name === "api-client-pod")).toBe(true);
    });

    it("api-client log shows connection refused and timeout errors", async () => {
      const logPath = path.join(
        dir,
        "cluster-resources",
        "pods",
        "logs",
        "default",
        "api-client-pod",
        "app.log",
      );
      expect(exists(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf8");
      expect(content).toContain("ECONNREFUSED");
      expect(content).toContain("connection refused");
      expect(content).toContain("request timeout");

      const logFile = await parseLogFile(logPath);
      expect(logFile.lines.length).toBeGreaterThan(0);
      expect(logFile.errorCount).toBeGreaterThan(0);
    });

    it("createTestBundle works with network-policy-deny scenario", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbi-netpol-"));
      const outPath = path.join(tmpDir, "network-policy-deny.tar.gz");
      try {
        const result = await createTestBundle(dir, outPath);
        expect(exists(result)).toBe(true);
        expect(fs.statSync(result).size).toBeGreaterThan(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: node-taint-memory-pressure
  // ---------------------------------------------------------------------------

  describe("Scenario 7: node-taint-memory-pressure", () => {
    const dir = getFixturePath("node-taint-memory-pressure");

    it("fixture directory exists", () => {
      expect(exists(dir)).toBe(true);
    });

    it("has version.yaml with SupportBundle kind", () => {
      const versionPath = path.join(dir, "version.yaml");
      expect(exists(versionPath)).toBe(true);
      expect(fs.readFileSync(versionPath, "utf8")).toContain("SupportBundle");
    });

    it("has cluster_version.json", () => {
      expect(exists(path.join(dir, "cluster-info", "cluster_version.json"))).toBe(true);
    });

    it("analysis.json contains scheduling failure and MemoryPressure insights", () => {
      const raw = fs.readFileSync(path.join(dir, "analysis.json"), "utf8");
      const results = parseAnalyzerJson(raw);
      expect(results.some((r) => r.severity === "error")).toBe(true);
      expect(raw).toContain("ml-worker-pod");
      expect(raw).toContain("node.kubernetes.io/memory-pressure");
      expect(raw).toContain("worker-node-1");
    });

    it("contains a pending pod without tolerations", () => {
      const podPath = path.join(
        dir,
        "cluster-resources",
        "pods",
        "default",
        "ml-worker-pod.yaml",
      );
      expect(exists(podPath)).toBe(true);
      const raw = fs.readFileSync(podPath, "utf8");
      expect(raw).toContain("name: ml-worker-pod");
      expect(raw).toContain("phase: Pending");
      expect(raw).toContain("untolerated taint");
      expect(raw.toLowerCase()).not.toContain("tolerations:");
    });

    it("contains a node YAML with the MemoryPressure taint", () => {
      const nodePath = path.join(
        dir,
        "cluster-resources",
        "nodes",
        "worker-node-1.yaml",
      );
      expect(exists(nodePath)).toBe(true);
      const raw = fs.readFileSync(nodePath, "utf8");
      expect(raw).toContain("kind: Node");
      expect(raw).toContain("name: worker-node-1");
      expect(raw).toContain("node.kubernetes.io/memory-pressure");
      expect(raw).toContain("effect: NoSchedule");
      expect(raw).toContain("type: MemoryPressure");
      expect(raw).toContain("status: \"True\"");
    });

    it("events include FailedScheduling due to the untolerated memory-pressure taint", () => {
      const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
      expect(exists(eventsPath)).toBe(true);
      const events = parseEventsJson(fs.readFileSync(eventsPath, "utf8"));
      const failedScheduling = events.filter((e) => e.reason === "FailedScheduling");
      expect(failedScheduling.length).toBeGreaterThan(0);
      expect(failedScheduling.some((e) => e.message.includes("memory-pressure"))).toBe(true);
      expect(failedScheduling.some((e) => e.involvedObject.name === "ml-worker-pod")).toBe(true);
    });

    it("scheduler log contains scheduling warnings tied to MemoryPressure", async () => {
      const logPath = path.join(
        dir,
        "cluster-resources",
        "pods",
        "logs",
        "default",
        "ml-worker-pod",
        "scheduler.log",
      );
      expect(exists(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf8");
      expect(content).toContain("pending scheduling");
      expect(content).toContain("worker-node-1");
      expect(content).toContain("memory-pressure");

      const logFile = await parseLogFile(logPath);
      expect(logFile.lines.length).toBeGreaterThan(0);
      expect(logFile.errorCount).toBeGreaterThan(0);
    });

    it("createTestBundle works with node-taint-memory-pressure scenario", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbi-taint-"));
      const outPath = path.join(tmpDir, "node-taint-memory-pressure.tar.gz");
      try {
        const result = await createTestBundle(dir, outPath);
        expect(exists(result)).toBe(true);
        expect(fs.statSync(result).size).toBeGreaterThan(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: helm-release-failure
  // ---------------------------------------------------------------------------

  describe("Scenario 8: helm-release-failure", () => {
    const dir = getFixturePath("helm-release-failure");

    it("fixture directory exists", () => {
      expect(exists(dir)).toBe(true);
    });

    it("has version.yaml with SupportBundle kind", () => {
      const versionPath = path.join(dir, "version.yaml");
      expect(exists(versionPath)).toBe(true);
      expect(fs.readFileSync(versionPath, "utf8")).toContain("SupportBundle");
    });

    it("has cluster_version.json", () => {
      expect(exists(path.join(dir, "cluster-info", "cluster_version.json"))).toBe(true);
    });

    it("analysis.json contains Helm failure analyzer entries", () => {
      const raw = fs.readFileSync(path.join(dir, "analysis.json"), "utf8");
      const results = parseAnalyzerJson(raw);
      expect(results.some((r) => r.severity === "error")).toBe(true);
      expect(results.some((r) => r.severity === "warn")).toBe(true);
      expect(raw).toContain("Helm release 'storefront'");
      expect(raw).toContain("APP_MODE=invalid_mode");
    });

    it("contains a parseable failed Helm release file", () => {
      const releasePath = path.join(dir, "helm", "releases", "storefront.json");
      expect(exists(releasePath)).toBe(true);
      const raw = fs.readFileSync(releasePath, "utf8");
      const releases = parseHelmReleaseContent(raw);
      expect(releases).toHaveLength(1);
      expect(releases[0]!.name).toBe("storefront");
      expect(releases[0]!.status).toBe("failed");
      expect(releases[0]!.chart).toBe("storefront");
      expect(releases[0]!.chartVersion).toBe("2.3.1");
      expect(releases[0]!.values["env"]).toBeDefined();
    });

    it("contains a CrashLoopBackOff hook pod with Helm hook labels", () => {
      const podPath = path.join(
        dir,
        "cluster-resources",
        "pods",
        "default",
        "storefront-hook-pod.yaml",
      );
      expect(exists(podPath)).toBe(true);
      const raw = fs.readFileSync(podPath, "utf8");
      expect(raw).toContain("storefront-hook-pod");
      expect(raw).toContain("helm.sh/hook: post-install");
      expect(raw).toContain("CrashLoopBackOff");
      expect(raw).toContain("APP_MODE");
      expect(raw).toContain("invalid_mode");
    });

    it("events include Failed and BackOff reasons for the hook pod", () => {
      const eventsPath = path.join(dir, "cluster-resources", "events", "default.json");
      expect(exists(eventsPath)).toBe(true);
      const events = parseEventsJson(fs.readFileSync(eventsPath, "utf8"));
      expect(events.some((e) => e.reason === "Failed")).toBe(true);
      expect(events.some((e) => e.reason === "BackOff")).toBe(true);
      expect(events.some((e) => e.message.includes("storefront"))).toBe(true);
    });

    it("hook pod log contains Helm-related startup errors", async () => {
      const logPath = path.join(
        dir,
        "cluster-resources",
        "pods",
        "logs",
        "default",
        "storefront-hook-pod",
        "hook.log",
      );
      expect(exists(logPath)).toBe(true);
      const raw = fs.readFileSync(logPath, "utf8");
      expect(raw).toContain("Helm post-install hook");
      expect(raw).toContain("storefront");
      expect(raw).toContain("invalid_mode");
      expect(raw).toContain("FAILED");

      const logFile = await parseLogFile(logPath);
      expect(logFile.lines.length).toBeGreaterThan(0);
      expect(logFile.errorCount).toBeGreaterThan(0);
    });

    it("createTestBundle works with helm-release-failure scenario", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbi-helm-"));
      const outPath = path.join(tmpDir, "helm-release-failure.tar.gz");
      try {
        const result = await createTestBundle(dir, outPath);
        expect(exists(result)).toBe(true);
        expect(fs.statSync(result).size).toBeGreaterThan(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
