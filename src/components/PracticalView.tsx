import React from 'react';
import {SubjectsAndLecturesView} from './StudentViews.tsx';
import {catalogByContentType} from '../lib/lecture-kinds.ts';
export default function PracticalView({catalog,onShortAnswers,...props}:{catalog:any;dashboardData:any;onStartSession:(params:any)=>void;onShortAnswers?:(id:number)=>void;initialSelectedSubjectId?:number|'all';onOpenSession?:(id:number,review?:boolean)=>void;onResetProgress?:(lectureId:number)=>Promise<void>;isAdmin?:boolean;onRefresh?:()=>void}){
 return <SubjectsAndLecturesView {...props} catalog={catalogByContentType(catalog,'practical')} kind="practical"/>;
}
