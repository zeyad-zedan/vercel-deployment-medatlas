/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  BookOpen,
  Bookmark,
  Clock,
  GraduationCap,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  SlidersHorizontal,
  User,
  X,
} from 'lucide-react';
import { api, subscribeToAuthChanges, type UserProfile } from './lib/api.ts';
import { PublicLanding } from './components/PublicLanding.tsx';
import { McqSessionPlayer } from './components/McqSessionPlayer.tsx';
import {
  DashboardView,
  SubjectsAndLecturesView,
  CustomPracticeView,
  MockExamsView,
  BookmarksView,
  ProgressHistoryView,
  ProfileSettingsView,
} from './components/StudentViews.tsx';
import { AdminConsole } from './components/AdminConsole.tsx';
import { BrandLogo } from './components/BrandLogo.tsx';

const VALID_TABS = [
  'dashboard',
  'subjects',
  'lectures',
  'practice',
  'exams',
  'bookmarks',
  'progress',
  'profile',
  'admin',
] as const;

function parseCurrentRoute(): { tab: string; sessionId: number | null } {
  if (typeof window === 'undefined') {
    return { tab: 'dashboard', sessionId: null };
  }

  const pathname = window.location.pathname.replace(/^\/+|\/+$/g, '');
  const searchParams = new URLSearchParams(window.location.search);

  // Check query params: ?session=8 or ?tab=progress
  const querySession = searchParams.get('session');
  if (querySession) {
    const id = parseInt(querySession, 10);
    if (!isNaN(id) && id > 0) return { tab: 'dashboard', sessionId: id };
  }

  const queryTab = searchParams.get('tab');
  if (queryTab && VALID_TABS.includes(queryTab as any)) {
    return { tab: queryTab, sessionId: null };
  }

  // Check path: /session/8
  const sessionMatch = pathname.match(/^session\/(\d+)/i);
  if (sessionMatch) {
    const id = parseInt(sessionMatch[1], 10);
    if (!isNaN(id) && id > 0) return { tab: 'dashboard', sessionId: id };
  }

  // Check path: /subjects, /lectures, /progress, etc.
  const firstSegment = pathname.split('/')[0]?.toLowerCase();
  if (firstSegment && VALID_TABS.includes(firstSegment as any)) {
    return { tab: firstSegment, sessionId: null };
  }

  return { tab: 'dashboard', sessionId: null };
}

function updateBrowserUrl(tab: string, session: any | null, replace = false) {
  if (typeof window === 'undefined') return;

  let targetUrl = '/';
  let targetTitle = 'MedAtlas MCQ';

  if (session && session.id) {
    targetUrl = `/session/${session.id}`;
    targetTitle = `${session.title || 'MCQ Session'} · MedAtlas MCQ`;
  } else if (tab && tab !== 'dashboard') {
    targetUrl = `/${tab}`;
    const capitalized = tab.charAt(0).toUpperCase() + tab.slice(1);
    targetTitle = `${capitalized} · MedAtlas MCQ`;
  }

  document.title = targetTitle;

  const currentPath = window.location.pathname;
  if (currentPath !== targetUrl) {
    if (replace) {
      window.history.replaceState({ tab, sessionId: session?.id || null }, targetTitle, targetUrl);
    } else {
      window.history.pushState({ tab, sessionId: session?.id || null }, targetTitle, targetUrl);
    }
  }
}

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [initializingAuth, setInitializingAuth] = useState(true);
  const [activeTab, setActiveTab] = useState<string>(() => parseCurrentRoute().tab);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('sidebar_open');
      if (saved !== null) return saved === 'true';
      return window.innerWidth >= 1024;
    }
    return true;
  });

  const toggleSidebar = () => {
    setSidebarOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('sidebar_open', String(next));
      } catch {}
      return next;
    });
  };

  const [catalog, setCatalog] = useState<any | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  const [dashboardData, setDashboardData] = useState<any | null>(null);
  const [loadingDashboard, setLoadingDashboard] = useState(false);

  const [bookmarksData, setBookmarksData] = useState<any | null>(null);
  const [adminData, setAdminData] = useState<any | null>(null);
  const [loadingAdmin, setLoadingAdmin] = useState(false);

  const [activeSession, setActiveSession] = useState<any | null>(null);
  const [sessionShortfall, setSessionShortfall] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [authRedirectError, setAuthRedirectError] = useState<string | null>(null);
  const [selectedSubjectId, setSelectedSubjectId] = useState<number | 'all'>('all');

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const data = await api.getCatalog();
      setCatalog(data);
    } catch (err: any) {
      console.error('Failed to load catalog:', err);
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  const loadStudentWorkspaceData = useCallback(async (silent = false) => {
    if (!silent) setLoadingDashboard(true);
    try {
      const [dash, bkm] = await Promise.all([
        api.getDashboard(),
        api.getBookmarks(),
      ]);
      setDashboardData(dash);
      setBookmarksData(bkm);
    } catch (err: any) {
      console.error('Error loading workspace data:', err);
    } finally {
      if (!silent) setLoadingDashboard(false);
    }
  }, []);

  const loadAdminData = useCallback(async () => {
    setLoadingAdmin(true);
    try {
      const data = await api.getAdminOverview();
      setAdminData(data);
    } catch (err: any) {
      setGlobalError(err.message || 'Failed to load admin console.');
    } finally {
      setLoadingAdmin(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
    const unsubscribe = subscribeToAuthChanges(
      (resolvedUser) => {
        if (resolvedUser) {
          setAuthRedirectError(null);
          const route = parseCurrentRoute();
          setActiveTab(route.tab || 'dashboard');
        }
        setUser(resolvedUser);
        setInitializingAuth(false);
      },
      (error) => {
        setAuthRedirectError(error.message || 'Google sign-in via redirect could not be completed.');
        setInitializingAuth(false);
      }
    );
    return () => unsubscribe();
  }, [loadCatalog]);

  useEffect(() => {
    if (user) {
      loadCatalog();
      loadStudentWorkspaceData();
      if (user.role === 'admin') {
        loadAdminData();
      }
    }
  }, [user, loadCatalog, loadStudentWorkspaceData, loadAdminData]);

  // Restore active session directly from URL path (/session/:id) or localStorage
  useEffect(() => {
    if (!user || activeSession) return;
    try {
      const route = parseCurrentRoute();
      let targetSessionId = route.sessionId;
      if (!targetSessionId) {
        const activeIdStr = localStorage.getItem('medatlas_active_session_id');
        if (activeIdStr) targetSessionId = parseInt(activeIdStr, 10);
      }

      if (targetSessionId && !isNaN(targetSessionId) && targetSessionId > 0) {
        api.getSession(targetSessionId)
          .then((res) => {
            if (res.session && (res.session.status === 'in_progress' || route.sessionId)) {
              setActiveSession(res.session);
            } else {
              localStorage.removeItem('medatlas_active_session_id');
            }
          })
          .catch(() => {
            localStorage.removeItem('medatlas_active_session_id');
          });
      }
    } catch {}
  }, [user]);

  // Sync activeSession ID to localStorage so progress is retained if browser closes
  useEffect(() => {
    try {
      if (activeSession && activeSession.status === 'in_progress') {
        localStorage.setItem('medatlas_active_session_id', String(activeSession.id));
      } else if (!activeSession || activeSession.status === 'completed') {
        localStorage.removeItem('medatlas_active_session_id');
      }
    } catch {}
  }, [activeSession]);

  // Keep the browser address bar and history in sync with active tab and active session
  useEffect(() => {
    if (!user || initializingAuth) return;
    updateBrowserUrl(activeTab, activeSession);
  }, [activeTab, activeSession, user, initializingAuth]);

  // Handle browser native Back and Forward navigation buttons
  useEffect(() => {
    const handlePopState = () => {
      const route = parseCurrentRoute();
      if (route.sessionId) {
        api.getSession(route.sessionId)
          .then((res) => {
            setActiveSession(res.session);
            setSessionShortfall(null);
          })
          .catch(() => {
            setActiveSession(null);
            setActiveTab('dashboard');
            updateBrowserUrl('dashboard', null, true);
            loadStudentWorkspaceData(true);
          });
      } else {
        setActiveSession(null);
        setActiveTab(route.tab);
        loadStudentWorkspaceData(true);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [loadStudentWorkspaceData]);

  const handleAuthenticated = (loggedInUser: UserProfile, initialTab?: string) => {
    setUser(loggedInUser);
    const route = parseCurrentRoute();
    setActiveTab(initialTab || route.tab || 'dashboard');
    setGlobalError(null);
    setAuthRedirectError(null);
  };

  const handleLogout = async () => {
    try {
      localStorage.removeItem('medatlas_active_session_id');
    } catch {}
    await api.logout();
    setUser(null);
    setActiveSession(null);
    setDashboardData(null);
    setBookmarksData(null);
    setAdminData(null);
    setActiveTab('dashboard');
    updateBrowserUrl('dashboard', null, true);
  };

  const handleHomeNavigation = (e?: React.MouseEvent) => {
    if (e) e.preventDefault();
    try {
      localStorage.removeItem('medatlas_active_session_id');
    } catch {}
    if (activeSession) {
      if (window.confirm('Leave current session and return to dashboard?')) {
        setActiveSession(null);
        setActiveTab('dashboard');
        updateBrowserUrl('dashboard', null, true);
      }
    } else {
      setActiveTab('dashboard');
      updateBrowserUrl('dashboard', null, true);
    }
  };

  const handleStartSession = async (params: any) => {
    setGlobalError(null);
    try {
      const res = await api.startSession(params);
      setActiveSession(res.session);
      setSessionShortfall(res.shortfallNotice);
    } catch (err: any) {
      setGlobalError(err.message || 'Could not start question session.');
    }
  };

  const handleOpenExistingSession = async (sessionId: number) => {
    setGlobalError(null);
    try {
      const res = await api.getSession(sessionId);
      setActiveSession(res.session);
      setSessionShortfall(null);
    } catch (err: any) {
      setGlobalError(err.message || 'Could not load session.');
    }
  };

  if (initializingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] text-slate-600 text-sm">
        Loading MedAtlas MCQ...
      </div>
    );
  }

  if (!user) {
    return (
      <PublicLanding
        catalog={catalog}
        loadingCatalog={loadingCatalog}
        onAuthenticated={handleAuthenticated}
        initialAuthError={authRedirectError}
      />
    );
  }

  const navItems = [
    { id: 'dashboard', label: 'Home', icon: LayoutDashboard },
    { id: 'subjects', label: 'Subjects', icon: BookOpen },
    { id: 'lectures', label: 'Lectures', icon: GraduationCap },
    { id: 'practice', label: 'Practice MCQs', icon: SlidersHorizontal },
    { id: 'exams', label: 'Mock Exams', icon: Clock },
    { id: 'bookmarks', label: 'Bookmarks', icon: Bookmark },
    { id: 'progress', label: 'My Progress', icon: History },
    { id: 'profile', label: 'Profile & Settings', icon: User },
  ];

  if (user.role === 'admin') {
    navItems.push({ id: 'admin', label: 'Admin Console', icon: ShieldCheck });
  }

  return (
    <div className="min-h-screen flex bg-[#F8FAFC] text-[#0F172A] relative">
      {/* Mobile Backdrop Overlay when side panel is open */}
      {sidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-xs transition-opacity cursor-pointer"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Side Panel Navigation (Collapsible on all screen sizes) */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-slate-200 flex flex-col transition-transform duration-300 ease-in-out shadow-xl lg:shadow-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <BrandLogo href="/" onClick={handleHomeNavigation} size="md" />
          <button
            type="button"
            onClick={() => {
              setSidebarOpen(false);
              try {
                localStorage.setItem('sidebar_open', 'false');
              } catch {}
            }}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            title="Close side panel"
            aria-label="Close side panel"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        <nav
          aria-label="Student Workspace Navigation"
          className="flex-1 px-3 py-4 space-y-1 overflow-y-auto"
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = !activeSession && activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  try {
                    localStorage.removeItem('medatlas_active_session_id');
                  } catch {}
                  if (activeSession) {
                    loadStudentWorkspaceData(true);
                  }
                  setActiveSession(null);
                  setActiveTab(item.id);
                  if (item.id === 'subjects') {
                    setSelectedSubjectId('all');
                  }
                  setGlobalError(null);
                  if (typeof window !== 'undefined' && window.innerWidth < 1024) {
                    setSidebarOpen(false);
                  }
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  isActive
                    ? 'bg-sky-50 text-[#0284C7] font-semibold'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3 text-xs">
          <div className="px-2">
            <p className="font-bold text-slate-900 truncate">{user.displayName}</p>
            <p className="text-slate-500 truncate">{user.email}</p>
            <p className="text-[11px] font-mono-tabular text-slate-400 uppercase mt-0.5">
              {user.role === 'admin' ? 'Platform Administrator' : 'Medical Student'} · Free Trial
            </p>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold text-slate-700 hover:text-red-700 bg-slate-100 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area (Smoothly expands to full width when sidebar is closed) */}
      <div
        className={`flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out ${
          sidebarOpen ? 'lg:pl-64' : 'lg:pl-0'
        }`}
      >
        {/* Top Workspace Header */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between gap-4 sm:gap-8">
          <div className="flex items-center gap-2.5 sm:gap-3.5 min-w-0">
            {/* Side Panel Toggle Button */}
            <button
              type="button"
              aria-label={sidebarOpen ? 'Close side panel' : 'Open side panel'}
              title={sidebarOpen ? 'Close side panel' : 'Open side panel'}
              onClick={toggleSidebar}
              className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer shrink-0 flex items-center justify-center"
            >
              {sidebarOpen ? (
                <PanelLeftClose className="w-5 h-5 text-slate-700" />
              ) : (
                <PanelLeftOpen className="w-5 h-5 text-slate-700" />
              )}
            </button>

            {!sidebarOpen && (
              <div className="hidden sm:flex items-center pr-3 border-r border-slate-200">
                <BrandLogo href="/" onClick={handleHomeNavigation} size="sm" showSubtitle={false} />
              </div>
            )}

            <span className="text-sm font-semibold text-slate-700 truncate">
              {activeSession
                ? `Active Session / ${activeSession.title}`
                : `Workspace / ${
                    navItems.find((n) => n.id === activeTab)?.label || 'Dashboard'
                  }`}
            </span>
          </div>

          <div className="hidden md:flex items-center gap-6 text-xs text-slate-500 font-mono-tabular">
            <span>{user.displayName}</span>
            <span>·</span>
            <span>
              {user.role === 'admin' ? 'Administrator Access' : 'Access: Free Trial Unlocked'}
            </span>
          </div>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleLogout}
              className="px-3.5 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Sign Out
            </button>
          </div>
        </header>

        {/* Workspace Viewport */}
        <main className={`flex-1 w-full mx-auto ${activeSession ? 'max-w-[1536px] px-2 sm:px-4 py-2 sm:py-3' : 'max-w-6xl px-4 sm:px-6 lg:px-8 py-8'}`}>
          {globalError && (
            <div
              role="alert"
              className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-center justify-between"
            >
              <span>{globalError}</span>
              <button
                type="button"
                onClick={() => setGlobalError(null)}
                className="font-semibold underline ml-4 cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          {activeSession ? (
            <McqSessionPlayer
              initialSession={activeSession}
              shortfallNotice={sessionShortfall}
              onExit={() => {
                setActiveSession(null);
                loadStudentWorkspaceData(true);
              }}
              onSessionCompleted={(completed) => {
                setActiveSession(completed);
                loadStudentWorkspaceData(true);
              }}
              onQuestionAnswered={() => {
                loadStudentWorkspaceData(true);
              }}
            />
          ) : (
            <>
              {activeTab === 'dashboard' && (
                <DashboardView
                  dashboardData={dashboardData}
                  loading={loadingDashboard}
                  onStartQuickSession={handleStartSession}
                  onOpenSession={handleOpenExistingSession}
                  onNavigateTab={setActiveTab}
                  onSelectModule={(subjectId) => {
                    setSelectedSubjectId(subjectId);
                    setActiveTab('subjects');
                  }}
                />
              )}

              {(activeTab === 'subjects' || activeTab === 'lectures') && (
                <SubjectsAndLecturesView
                  catalog={catalog}
                  dashboardData={dashboardData}
                  initialSelectedSubjectId={selectedSubjectId}
                  onSelectSubjectId={setSelectedSubjectId}
                  onStartSession={handleStartSession}
                  onRefresh={() => {
                    loadStudentWorkspaceData();
                    loadCatalog();
                    if (user?.role === 'admin') loadAdminData();
                  }}
                  isAdmin={user?.role === 'admin'}
                />
              )}

              {activeTab === 'practice' && (
                <CustomPracticeView
                  catalog={catalog}
                  onStartSession={handleStartSession}
                />
              )}

              {activeTab === 'exams' && (
                <MockExamsView
                  catalog={catalog}
                  dashboardData={dashboardData}
                  onStartSession={handleStartSession}
                  onOpenSession={handleOpenExistingSession}
                  onRefresh={loadStudentWorkspaceData}
                />
              )}

              {activeTab === 'bookmarks' && (
                <BookmarksView
                  bookmarksData={bookmarksData}
                  catalog={catalog}
                  onRefresh={loadStudentWorkspaceData}
                />
              )}

              {activeTab === 'progress' && (
                <ProgressHistoryView
                  dashboardData={dashboardData}
                  onOpenSession={handleOpenExistingSession}
                />
              )}

              {activeTab === 'profile' && (
                <ProfileSettingsView
                  user={user}
                  onUserUpdated={(updatedUser) => setUser(updatedUser)}
                  onAccountDeleted={handleLogout}
                />
              )}

              {activeTab === 'admin' && user.role === 'admin' && (
                <AdminConsole
                  adminData={adminData}
                  loading={loadingAdmin}
                  onRefresh={() => {
                    loadAdminData();
                    loadCatalog();
                  }}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
