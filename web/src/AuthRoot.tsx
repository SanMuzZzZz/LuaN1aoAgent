import { Skeleton } from "antd";
import App from "./App";
import { AuthScreen } from "./components/AuthScreen";
import { useAuth } from "./useAuth";

export function AuthRoot() {
  const auth = useAuth();
  if (auth.loading) {
    return <div className="auth-loading"><Skeleton active paragraph={{ rows: 6 }} /></div>;
  }
  if (!auth.user) {
    return (
      <AuthScreen
        submitting={auth.submitting}
        error={auth.error}
        onClearError={auth.clearError}
        onLogin={auth.login}
        onRegister={auth.register}
      />
    );
  }
  return <App user={auth.user} onLogout={auth.logout} />;
}
