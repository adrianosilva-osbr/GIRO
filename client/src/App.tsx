import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout, ProjectLayout } from './components/Layout';
import { AuthPage } from './pages/AuthPage';
import { HomePage } from './pages/HomePage';
import { ProjectsPage } from './pages/ProjectsPage';
import { BoardPage } from './pages/BoardPage';
import { BacklogPage } from './pages/BacklogPage';
import { IssueSearchPage } from './pages/IssueSearchPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="filters" element={<IssueSearchPage />} />
          <Route path="projects/:key" element={<ProjectLayout />}>
            <Route index element={<Navigate to="board" replace />} />
            <Route path="board" element={<BoardPage />} />
            <Route path="backlog" element={<BacklogPage />} />
            <Route path="issues" element={<IssueSearchPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
