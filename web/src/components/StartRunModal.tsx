import { useState } from "react";
import { Alert, Form, Input, InputNumber, Modal } from "antd";
import { startRun } from "../api";

interface StartRunModalProps {
  open: boolean;
  onClose: () => void;
  onStarted: (runtimeDir: string) => void;
}

export function StartRunModal({ open, onClose, onStarted }: StartRunModalProps) {
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
      title="启动新任务"
      open={open}
      okText="启动"
      cancelText="取消"
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
        <Form.Item name="goal" label="任务目标" rules={[{ required: true, whitespace: true, message: "请输入任务目标" }]}>
          <Input.TextArea rows={4} maxLength={4000} placeholder="例如：对授权目标 http://10.0.x.x 进行安全测试，寻找并提交所有 flag" />
        </Form.Item>
        <Form.Item name="scope" label="授权范围" rules={[{ required: true, whitespace: true, message: "请输入授权范围" }]}>
          <Input.TextArea rows={3} maxLength={4000} placeholder="例如：仅限 http://10.0.x.x；禁止访问或攻击其他主机" />
        </Form.Item>
        <div style={{ display: "flex", gap: 12 }}>
          <Form.Item name="maxRunTimeMin" label="最大运行时间（分钟）" style={{ flex: 1 }}>
            <InputNumber min={1} max={180} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="maxParallelTasks" label="并行任务数" style={{ flex: 1 }}>
            <InputNumber min={1} max={8} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="maxPlannerCycles" label="Planner 最大循环" style={{ flex: 1 }}>
            <InputNumber min={1} max={64} style={{ width: "100%" }} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
