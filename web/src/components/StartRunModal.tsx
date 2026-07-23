import { useState } from "react";
import { Alert, Form, Input, InputNumber, Modal } from "antd";
import { startRun } from "../api";
import { useLanguage } from "../language";

interface StartRunModalProps {
  open: boolean;
  onClose: () => void;
  onStarted: (runtimeDir: string) => void;
}

export function StartRunModal({ open, onClose, onStarted }: StartRunModalProps) {
  const { t } = useLanguage();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await startRun({
        goal: String(values.goal).trim(),
        scope: String(values.scope).trim(),
        maxRunTimeMs: values.maxRunTimeMin ? Math.round(values.maxRunTimeMin * 60_000) : undefined,
        maxParallelTasks: values.maxParallelTasks ?? undefined,
        maxPlannerCycles: values.maxPlannerCycles ?? undefined
      });
      form.resetFields();
      onStarted(result.runtimeDir);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t("startRun.title")}
      open={open}
      okText={t("common.start")}
      cancelText={t("common.cancel")}
      confirmLoading={submitting}
      width={560}
      destroyOnHidden
      onOk={() => void submit()}
      onCancel={() => {
        if (submitting) return;
        setError(undefined);
        onClose();
      }}
    >
      {error ? <Alert style={{ marginBottom: 12 }} type="error" showIcon message={error} /> : null}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ maxRunTimeMin: 15, maxParallelTasks: 2, maxPlannerCycles: 8 }}
      >
        <Form.Item name="goal" label={t("startRun.goal")} rules={[{ required: true, whitespace: true, message: t("startRun.goalRequired") }]}>
          <Input.TextArea rows={4} maxLength={4000} placeholder={t("startRun.goalPlaceholder")} />
        </Form.Item>
        <Form.Item name="scope" label={t("startRun.scope")} rules={[{ required: true, whitespace: true, message: t("startRun.scopeRequired") }]}>
          <Input.TextArea rows={3} maxLength={4000} placeholder={t("startRun.scopePlaceholder")} />
        </Form.Item>
        <div style={{ display: "flex", gap: 12 }}>
          <Form.Item name="maxRunTimeMin" label={t("startRun.maxMinutes")} style={{ flex: 1 }}>
            <InputNumber min={1} max={180} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="maxParallelTasks" label={t("startRun.parallelTasks")} style={{ flex: 1 }}>
            <InputNumber min={1} max={8} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="maxPlannerCycles" label={t("startRun.plannerCycles")} style={{ flex: 1 }}>
            <InputNumber min={1} max={64} style={{ width: "100%" }} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
