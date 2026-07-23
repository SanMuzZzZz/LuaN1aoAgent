import { Alert, Button, Form, Input, Tabs, Tag, Tooltip, Typography } from "antd";
import { Activity, GitBranch, Languages, LockKeyhole, Network, ShieldCheck, UserRound } from "lucide-react";
import { useLanguage } from "../language";

interface AuthScreenProps {
  submitting: boolean;
  error?: string;
  onClearError: () => void;
  onLogin: (input: { username: string; password: string }) => Promise<void>;
  onRegister: (input: { username: string; displayName: string; password: string }) => Promise<void>;
}

export function AuthScreen(props: AuthScreenProps) {
  const { locale, t, toggleLocale } = useLanguage();
  return (
    <div className="auth-shell">
      <section className="auth-product">
        <div className="auth-brand">
          <div className="brand-mark">鸾</div>
          <div><strong>{t("auth.brand")}</strong><span>Agent Operations Workbench</span></div>
          <Tooltip title={locale === "zh-CN" ? t("language.switchToEnglish") : t("language.switchToChinese")}>
            <Button type="text" icon={<Languages size={18} />} onClick={toggleLocale}>{locale === "zh-CN" ? "English" : "中文"}</Button>
          </Tooltip>
        </div>
        <div className="auth-product-copy">
          <Tag color="blue">SECURITY AGENT PLATFORM</Tag>
          <Typography.Title level={1}>{t("auth.tagline")}</Typography.Title>
          <p>{t("auth.description")}</p>
        </div>
        <div className="auth-capability-grid">
          <Capability icon={<Activity size={18} />} title={t("auth.capability.trace")} description={t("auth.capability.traceDescription")} />
          <Capability icon={<GitBranch size={18} />} title={t("auth.capability.graph")} description={t("auth.capability.graphDescription")} />
          <Capability icon={<Network size={18} />} title={t("auth.capability.session")} description={t("auth.capability.sessionDescription")} />
          <Capability icon={<ShieldCheck size={18} />} title={t("auth.capability.protection")} description={t("auth.capability.protectionDescription")} />
        </div>
        <div className="auth-system-strip">
          <span><i className="online" /> {t("auth.serviceReady")}</span>
          <span>{t("auth.sessionProtected")}</span>
          <span>{t("auth.sqlitePersistence")}</span>
        </div>
      </section>

      <section className="auth-access">
        <div className="auth-panel">
          <div className="auth-panel-heading">
            <span>{t("auth.access")}</span>
            <Typography.Title level={2}>{t("auth.enterWorkbench")}</Typography.Title>
            <p>{t("auth.accessDescription")}</p>
          </div>
          {props.error ? <Alert closable type="error" showIcon message={props.error} onClose={props.onClearError} /> : null}
          <Tabs
            defaultActiveKey="login"
            items={[
              { key: "login", label: t("auth.login"), children: <LoginForm submitting={props.submitting} onSubmit={props.onLogin} /> },
              { key: "register", label: t("auth.register"), children: <RegisterForm submitting={props.submitting} onSubmit={props.onRegister} /> }
            ]}
          />
          <div className="auth-security-note"><LockKeyhole size={14} /><span>{t("auth.securityNote")}</span></div>
        </div>
      </section>
    </div>
  );
}

function LoginForm({ submitting, onSubmit }: { submitting: boolean; onSubmit: AuthScreenProps["onLogin"] }) {
  const { t } = useLanguage();
  return (
    <Form layout="vertical" requiredMark={false} onFinish={(values) => void onSubmit(values).catch(() => undefined)}>
      <Form.Item label={t("auth.username")} name="username" rules={[{ required: true, message: t("auth.usernameRequired") }]}>
        <Input autoComplete="username" prefix={<UserRound size={16} />} placeholder="username" />
      </Form.Item>
      <Form.Item label={t("auth.password")} name="password" rules={[{ required: true, message: t("auth.passwordRequired") }]}>
        <Input.Password autoComplete="current-password" prefix={<LockKeyhole size={16} />} placeholder={t("auth.passwordPlaceholder")} />
      </Form.Item>
      <Button block type="primary" htmlType="submit" loading={submitting}>{t("auth.loginWorkbench")}</Button>
    </Form>
  );
}

function RegisterForm({ submitting, onSubmit }: { submitting: boolean; onSubmit: AuthScreenProps["onRegister"] }) {
  const { t } = useLanguage();
  return (
    <Form layout="vertical" requiredMark={false} onFinish={(values) => void onSubmit(values).catch(() => undefined)}>
      <Form.Item label={t("auth.displayName")} name="displayName" rules={[{ required: true, message: t("auth.displayNameRequired") }, { min: 2, max: 40 }]}>
        <Input autoComplete="name" prefix={<UserRound size={16} />} placeholder={t("auth.displayNamePlaceholder")} />
      </Form.Item>
      <Form.Item label={t("auth.username")} name="username" rules={[{ required: true }, { pattern: /^[a-zA-Z0-9_.-]{3,32}$/, message: t("auth.usernamePattern") }]}>
        <Input autoComplete="username" prefix={<UserRound size={16} />} placeholder="analyst" />
      </Form.Item>
      <Form.Item label={t("auth.password")} name="password" rules={[{ required: true }, { min: 8, max: 128, message: t("auth.passwordLength") }]}>
        <Input.Password autoComplete="new-password" prefix={<LockKeyhole size={16} />} placeholder={t("auth.passwordMinPlaceholder")} />
      </Form.Item>
      <Form.Item label={t("auth.confirmPassword")} name="confirmPassword" dependencies={["password"]} rules={[
        { required: true, message: t("auth.confirmPasswordRequired") },
        ({ getFieldValue }) => ({ validator: (_, value) => !value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error(t("auth.passwordMismatch"))) })
      ]}>
        <Input.Password autoComplete="new-password" prefix={<LockKeyhole size={16} />} placeholder={t("auth.confirmPasswordPlaceholder")} />
      </Form.Item>
      <Button block type="primary" htmlType="submit" loading={submitting}>{t("auth.createAccount")}</Button>
    </Form>
  );
}

function Capability({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return <div className="auth-capability"><span>{icon}</span><div><strong>{title}</strong><p>{description}</p></div></div>;
}
