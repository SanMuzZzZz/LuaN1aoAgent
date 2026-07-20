import { ConfigProvider, Skeleton } from "antd";
import App, { appTheme } from "./App";
import { AuthScreen } from "./components/AuthScreen";
import { useAuth } from "./useAuth";

export function AuthRoot() {
  const auth = useAuth();
  if (auth.loading) {
    return <ConfigProvider theme={appTheme}><div className="auth-loading"><Skeleton active paragraph={{ rows: 6 }} /></div></ConfigProvider>;
  }
  if (!auth.user) {
    return (
      <ConfigProvider theme={appTheme}>
        <AuthScreen
          submitting={auth.submitting}
          error={auth.error}
          onClearError={auth.clearError}
          onLogin={auth.login}
          onRegister={auth.register}
        />
      </ConfigProvider>
    );
  }
  return <App user={auth.user} onLogout={auth.logout} />;
}
