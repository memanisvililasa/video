import "server-only";

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]{0,127}$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const MAX_LABEL_VALUE_LENGTH = 96;

export type MetricLabels = Readonly<Record<string, string>>;
export type LabelValidator = (value: string) => boolean;
export type LabelValidators = Readonly<Record<string, LabelValidator>>;

type MetricKind = "counter" | "gauge" | "histogram";
type MetricDescriptor = Readonly<{
  name: string;
  help: string;
  kind: MetricKind;
  labels: LabelValidators;
  buckets?: readonly number[];
}>;

type Sample = { labels: MetricLabels; value: number };
type HistogramSample = Sample & { counts: number[]; sum: number; count: number };

function assertDescriptor(descriptor: MetricDescriptor): void {
  if (!METRIC_NAME.test(descriptor.name)) throw new TypeError("Metric name is invalid.");
  if (!descriptor.help || descriptor.help.length > 256 || /[\r\n\u0000]/.test(descriptor.help)) {
    throw new TypeError("Metric help is invalid.");
  }
  for (const label of Object.keys(descriptor.labels)) {
    if (!LABEL_NAME.test(label)) throw new TypeError("Metric label name is invalid.");
  }
}

function normalizeLabels(validators: LabelValidators, labels: MetricLabels = {}): MetricLabels {
  const required = Object.keys(validators).sort((left, right) => left.localeCompare(right, "en"));
  const actual = Object.keys(labels).sort((left, right) => left.localeCompare(right, "en"));
  if (required.length !== actual.length || required.some((key, index) => key !== actual[index])) {
    throw new TypeError("Metric labels do not match the registered contract.");
  }
  const normalized: Record<string, string> = {};
  for (const key of required) {
    const value = labels[key];
    if (value.length > MAX_LABEL_VALUE_LENGTH || /[\r\n\u0000]/.test(value) || !validators[key](value)) {
      throw new TypeError("Metric label value is outside its fixed allowlist.");
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

function keyFor(labels: MetricLabels): string {
  return JSON.stringify(labels);
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function renderLabels(labels: MetricLabels, extra: MetricLabels = {}): string {
  const entries = Object.entries({ ...labels, ...extra }).sort(([left], [right]) => left.localeCompare(right, "en"));
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

abstract class MetricBase {
  protected readonly samples = new Map<string, Sample | HistogramSample>();
  constructor(readonly descriptor: MetricDescriptor) {}
  protected labels(input?: MetricLabels): Readonly<{ key: string; labels: MetricLabels }> {
    const labels = normalizeLabels(this.descriptor.labels, input);
    return { key: keyFor(labels), labels };
  }
  abstract render(): string[];
}

export class Counter extends MetricBase {
  inc(labels?: MetricLabels, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError("Counter increments must be finite and non-negative.");
    const normalized = this.labels(labels);
    const sample = this.samples.get(normalized.key) as Sample | undefined;
    this.samples.set(normalized.key, { labels: normalized.labels, value: (sample?.value ?? 0) + amount });
  }
  render(): string[] {
    return [...this.samples.values()]
      .sort((a, b) => keyFor(a.labels).localeCompare(keyFor(b.labels), "en"))
      .map((sample) => `${this.descriptor.name}${renderLabels(sample.labels)} ${sample.value}`);
  }
}

export class Gauge extends MetricBase {
  set(labels: MetricLabels | undefined, value: number): void {
    if (!Number.isFinite(value)) throw new TypeError("Gauge values must be finite.");
    const normalized = this.labels(labels);
    this.samples.set(normalized.key, { labels: normalized.labels, value });
  }
  inc(labels?: MetricLabels, amount = 1): void {
    if (!Number.isFinite(amount)) throw new TypeError("Gauge increments must be finite.");
    const normalized = this.labels(labels);
    const sample = this.samples.get(normalized.key) as Sample | undefined;
    this.samples.set(normalized.key, { labels: normalized.labels, value: (sample?.value ?? 0) + amount });
  }
  dec(labels?: MetricLabels, amount = 1): void { this.inc(labels, -amount); }
  render(): string[] {
    return [...this.samples.values()]
      .sort((a, b) => keyFor(a.labels).localeCompare(keyFor(b.labels), "en"))
      .map((sample) => `${this.descriptor.name}${renderLabels(sample.labels)} ${sample.value}`);
  }
}

export class Histogram extends MetricBase {
  private readonly buckets: readonly number[];
  constructor(descriptor: MetricDescriptor) {
    super(descriptor);
    const buckets = descriptor.buckets ?? [];
    if (buckets.length === 0 || buckets.length > 32 || buckets.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new TypeError("Histogram buckets are invalid.");
    }
    if (buckets.some((value, index) => index > 0 && value <= buckets[index - 1])) {
      throw new TypeError("Histogram buckets must be strictly increasing.");
    }
    this.buckets = Object.freeze([...buckets]);
  }
  observe(labels: MetricLabels | undefined, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new TypeError("Histogram observations must be finite and non-negative.");
    const normalized = this.labels(labels);
    let sample = this.samples.get(normalized.key) as HistogramSample | undefined;
    if (!sample) sample = { labels: normalized.labels, value: 0, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((bucket, index) => { if (value <= bucket) sample!.counts[index] += 1; });
    sample.sum += value;
    sample.count += 1;
    this.samples.set(normalized.key, sample);
  }
  render(): string[] {
    const lines: string[] = [];
    const samples = [...this.samples.values()] as HistogramSample[];
    samples.sort((a, b) => keyFor(a.labels).localeCompare(keyFor(b.labels), "en"));
    for (const sample of samples) {
      this.buckets.forEach((bucket, index) => {
        lines.push(`${this.descriptor.name}_bucket${renderLabels(sample.labels, { le: String(bucket) })} ${sample.counts[index]}`);
      });
      lines.push(`${this.descriptor.name}_bucket${renderLabels(sample.labels, { le: "+Inf" })} ${sample.count}`);
      lines.push(`${this.descriptor.name}_sum${renderLabels(sample.labels)} ${sample.sum}`);
      lines.push(`${this.descriptor.name}_count${renderLabels(sample.labels)} ${sample.count}`);
    }
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, MetricBase>();
  constructor(private readonly maxResponseBytes = 64 * 1024) {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 4_096 || maxResponseBytes > 262_144) {
      throw new TypeError("Metrics response limit is invalid.");
    }
  }
  registerCounter(name: string, help: string, labels: LabelValidators = {}): Counter {
    return this.register({ name, help, kind: "counter", labels }, (descriptor) => new Counter(descriptor));
  }
  registerGauge(name: string, help: string, labels: LabelValidators = {}): Gauge {
    return this.register({ name, help, kind: "gauge", labels }, (descriptor) => new Gauge(descriptor));
  }
  registerHistogram(name: string, help: string, labels: LabelValidators, buckets: readonly number[]): Histogram {
    return this.register({ name, help, kind: "histogram", labels, buckets }, (descriptor) => new Histogram(descriptor));
  }
  private register<T extends MetricBase>(descriptor: MetricDescriptor, factory: (input: MetricDescriptor) => T): T {
    assertDescriptor(descriptor);
    if (this.metrics.has(descriptor.name)) throw new TypeError("Metric is already registered.");
    const metric = factory(Object.freeze(descriptor));
    this.metrics.set(descriptor.name, metric);
    return metric;
  }
  render(): string {
    const lines: string[] = [];
    for (const metric of [...this.metrics.values()].sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name, "en"))) {
      lines.push(`# HELP ${metric.descriptor.name} ${metric.descriptor.help}`);
      lines.push(`# TYPE ${metric.descriptor.name} ${metric.descriptor.kind}`);
      lines.push(...metric.render());
    }
    const output = `${lines.join("\n")}\n`;
    if (Buffer.byteLength(output, "utf8") > this.maxResponseBytes) throw new Error("Metrics response exceeds its configured bound.");
    return output;
  }
}
