import { Alert, Button, Form, Input, Tabs, Tag, Typography } from "antd";
import { Activity, GitBranch, LockKeyhole, Network, ShieldCheck, UserRound } from "lucide-react";

interface AuthScreenProps {
  submitting: boolean;
  error?: string;
  onClearError: () => void;
  onLogin: (input: { username: string; password: string }) => Promise<void>;
  onRegister: (input: { username: string; displayName: string; password: string }) => Promise<void>;
}

export function AuthScreen(props: AuthScreenProps) {
  return (
    <div className="auth-shell">
      <section className="auth-product">
        <div className="auth-brand">
          <div className="brand-mark">鸾</div>
          <div><strong>鸾鸟渗透智能体</strong><span>Agent Operations Workbench</span></div>
        </div>
        <div className="auth-product-copy">
          <Tag color="blue">SECURITY AGENT PLATFORM</Tag>
          <Typography.Title level={1}>统一观察智能体的判断、行动与证据。</Typography.Title>
          <p>面向安全研究与授权评测的多 Agent 运行工作台，集中管理实时轨迹、三图状态、任务队列和证据产物。</p>
        </div>
        <div className="auth-capability-grid">
          <Capability icon={<Activity size={18} />} title="实时轨迹" description="聚合 Agent 想法、动作和工具返回" />
          <Capability icon={<GitBranch size={18} />} title="三图推理" description="推理图、作战图与任务树同步联动" />
          <Capability icon={<Network size={18} />} title="会话管理" description="快速切换历史 Runtime 与执行上下文" />
          <Capability icon={<ShieldCheck size={18} />} title="访问保护" description="账号会话隔离敏感运行数据" />
        </div>
        <div className="auth-system-strip">
          <span><i className="online" /> Auth service ready</span>
          <span>Session protected</span>
          <span>SQLite persistence</span>
        </div>
      </section>

      <section className="auth-access">
        <div className="auth-panel">
          <div className="auth-panel-heading">
            <span>WORKSPACE ACCESS</span>
            <Typography.Title level={2}>进入鸾鸟工作台</Typography.Title>
            <p>使用团队账号登录，或注册一个新的分析员账号。</p>
          </div>
          {props.error ? <Alert closable type="error" showIcon message={props.error} onClose={props.onClearError} /> : null}
          <Tabs
            defaultActiveKey="login"
            items={[
              { key: "login", label: "登录", children: <LoginForm submitting={props.submitting} onSubmit={props.onLogin} /> },
              { key: "register", label: "注册", children: <RegisterForm submitting={props.submitting} onSubmit={props.onRegister} /> }
            ]}
          />
          <div className="auth-security-note"><LockKeyhole size={14} /><span>密码仅以加盐哈希保存，会话使用 HttpOnly Cookie。</span></div>
        </div>
      </section>
    </div>
  );
}

function LoginForm({ submitting, onSubmit }: { submitting: boolean; onSubmit: AuthScreenProps["onLogin"] }) {
  return (
    <Form layout="vertical" requiredMark={false} onFinish={(values) => void onSubmit(values).catch(() => undefined)}>
      <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
        <Input autoComplete="username" prefix={<UserRound size={16} />} placeholder="username" />
      </Form.Item>
      <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
        <Input.Password autoComplete="current-password" prefix={<LockKeyhole size={16} />} placeholder="输入密码" />
      </Form.Item>
      <Button block type="primary" htmlType="submit" loading={submitting}>登录工作台</Button>
    </Form>
  );
}

function RegisterForm({ submitting, onSubmit }: { submitting: boolean; onSubmit: AuthScreenProps["onRegister"] }) {
  return (
    <Form layout="vertical" requiredMark={false} onFinish={(values) => void onSubmit(values).catch(() => undefined)}>
      <Form.Item label="显示名称" name="displayName" rules={[{ required: true, message: "请输入显示名称" }, { min: 2, max: 40 }]}>
        <Input autoComplete="name" prefix={<UserRound size={16} />} placeholder="安全分析员" />
      </Form.Item>
      <Form.Item label="用户名" name="username" rules={[{ required: true }, { pattern: /^[a-zA-Z0-9_.-]{3,32}$/, message: "使用 3-32 位字母、数字或 ._-" }]}>
        <Input autoComplete="username" prefix={<UserRound size={16} />} placeholder="analyst" />
      </Form.Item>
      <Form.Item label="密码" name="password" rules={[{ required: true }, { min: 8, max: 128, message: "密码至少 8 位" }]}>
        <Input.Password autoComplete="new-password" prefix={<LockKeyhole size={16} />} placeholder="至少 8 位" />
      </Form.Item>
      <Form.Item label="确认密码" name="confirmPassword" dependencies={["password"]} rules={[
        { required: true, message: "请再次输入密码" },
        ({ getFieldValue }) => ({ validator: (_, value) => !value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error("两次输入的密码不一致")) })
      ]}>
        <Input.Password autoComplete="new-password" prefix={<LockKeyhole size={16} />} placeholder="再次输入密码" />
      </Form.Item>
      <Button block type="primary" htmlType="submit" loading={submitting}>创建账号并进入</Button>
    </Form>
  );
}

function Capability({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return <div className="auth-capability"><span>{icon}</span><div><strong>{title}</strong><p>{description}</p></div></div>;
}
