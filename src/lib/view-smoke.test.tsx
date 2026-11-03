import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubjectsAndLecturesView, DashboardView, CustomPracticeView, MockExamsView, BookmarksView, ProgressHistoryView, ProfileSettingsView } from '../components/StudentViews.tsx';
import { AdminConsole } from '../components/AdminConsole.tsx';
import { groupLectureModules } from './lecture-modules.ts';

test('student screens render empty accounts without crashing', () => {
  const catalog = {subjects: [], lectures: [], modules: [], totalPublishedQuestions: 0};
  const ignore = () => {};
  const screens = [
    <DashboardView dashboardData={{}} loading={false} onStartQuickSession={ignore} onOpenSession={ignore} onNavigateTab={ignore}/>,
    <CustomPracticeView catalog={catalog} onStartSession={ignore}/>,
    <MockExamsView catalog={catalog} dashboardData={{}} onStartSession={ignore} onOpenSession={ignore} onRefresh={ignore}/>,
    <BookmarksView catalog={catalog} bookmarksData={{bookmarks:[],answeredQuestions:[]}} onRefresh={ignore}/>,
    <ProgressHistoryView dashboardData={{history: []}} onOpenSession={ignore}/>,
    <ProfileSettingsView user={{id:1,uid:'review',displayName:'Review Student',email:'review@example.test',role:'student',subscriptionTier:'free_trial',subscriptionStatus:'active',emailVerified:true,preferences:'{}',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}} onUserUpdated={ignore} onAccountDeleted={ignore}/>,
  ];
  for (const screen of screens) assert.ok(renderToStaticMarkup(screen).length > 0);
  const dashboard = renderToStaticMarkup(screens[0]);
  assert.doesNotMatch(dashboard, /Topic Performance|Weak-Area Analysis/);
  assert.match(dashboard, /Recent Sessions/);
});

test('lecture browser renders collapsed subjects and preserves lecture actions', () => {
  const html = renderToStaticMarkup(<SubjectsAndLecturesView catalog={{subjects:[{id:1,title:'Physiology',lectures:[{id:2,title:'Cardiac Physiology',questionCount:10}]}]}} onStartSession={()=>{}}/>);
  assert.match(html, /<details[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen=/);
  assert.match(html, /<summary/);
  assert.match(html, /Cardiac Physiology/);
  assert.match(html, /Search subjects and lectures/);
});

test('Home subject entry expands its dropdown while keeping the full lecture library and real module options', () => {
  assert.deepEqual(groupLectureModules([{id:11,code:'BSF 112'},{id:12,code:'Bsf 112'},{id:13,code:'BSF112'}]),
    [{id:11,label:'BSF 112',moduleIds:[11,12,13]}]);
  const html = renderToStaticMarkup(<SubjectsAndLecturesView initialSelectedSubjectId={2} catalog={{
    modules:[{id:11,code:'BSF 112',title:'Basic Structure & Function'},{id:12,code:'TEST 204',title:'Another module'}],
    subjects:[{id:1,moduleId:11,title:'Anatomy',lectures:[]},{id:2,moduleId:11,title:'Biochemistry',lectures:[{id:5,title:'Carbohydrates'}]},
      {id:3,moduleId:12,title:'Physiology',lectures:[]}],
  }} onStartSession={()=>{}}/>);
  assert.equal((html.match(/<details\b/g)||[]).length,3,'choosing a Home subject must not hide other subjects');
  assert.equal((html.match(/<details[^>]*\bopen=/g)||[]).length,1);
  assert.match(html,/<details[^>]*open=""[\s\S]*?Biochemistry/);
  assert.match(html,/Expand all subjects/);assert.match(html,/Collapse all/);
  assert.match(html,/<option value="all" selected="">All modules<\/option>/);
  assert.match(html,/<option value="11">BSF 112<\/option>/);
  assert.match(html,/<option value="12">TEST 204<\/option>/);
  assert.doesNotMatch(html,/subjects to explore/);
});

test('admin overview never claims to measure Supabase usage or hardcodes PDF counts', () => {
  const html = renderToStaticMarkup(<AdminConsole loading={false} adminData={{metrics:{},isTelegramConfigured:true}} onRefresh={()=>{}}/>);
  assert.match(html, /Usage is not measured by this website/);
  assert.doesNotMatch(html, /18 \/ 18|Monthly Database Egress|Auto-lock active/);
  assert.match(html, /role="switch" aria-checked="false" aria-label="PDF security watermarks"/);
});

test('Dashboard shows session cards and filters without daily graphs or a history table', () => {
  const html = renderToStaticMarkup(<ProgressHistoryView dashboardData={{history:[
    {id:1,title:'Cardiac Physiology',subjectTitle:'Physiology',lectureTitle:'Cardiac Physiology',mode:'study',status:'in_progress',totalQuestions:50,answeredCount:20},
    {id:2,title:'Lipids',subjectTitle:'Biochemistry',lectureTitle:'Lipids',mode:'exam',status:'completed',totalQuestions:30,answeredCount:30,scorePercentage:90},
  ]}} onOpenSession={()=>{}}/>);
  assert.equal((html.match(/class="ma-session-card"/g) || []).length, 2);
  assert.match(html, /Dashboard/);
  assert.match(html, /Continue learning/);
  assert.match(html, /Review answers/);
  assert.match(html, /All sessions/);
  assert.doesNotMatch(html, /<table|<svg[^>]*role="img"|Daily MCQs|daily-activity/);
});
