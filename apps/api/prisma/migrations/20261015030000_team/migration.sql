-- AI team (VoiceFront team room): members, threads and messages, filed
-- work items, member drafts, tool-call logs, member notes, failure cases,
-- and watched pages. Platform level, not tenant-scoped. Only one foreign
-- key exists here: team_messages.thread_id -> team_threads (CASCADE).
-- WorkItem.source_thread_id, TeamDraft.source_thread_id and
-- FailureCase.call_log_id are plain strings by design, with no foreign key.

-- CreateEnum
CREATE TYPE "TeamThreadType" AS ENUM ('DM', 'GROUP', 'CEO', 'DISCUSS');

-- CreateEnum
CREATE TYPE "TeamAuthorType" AS ENUM ('OWNER', 'MEMBER', 'CEO', 'SYSTEM');

-- CreateEnum
CREATE TYPE "WorkItemStatus" AS ENUM ('QUEUED', 'IN_PROGRESS', 'DONE');

-- CreateEnum
CREATE TYPE "TeamDraftKind" AS ENUM ('EMAIL', 'COPY', 'AD', 'POST', 'QA_REPORT', 'SCORECARD', 'RESEARCH_BRIEF', 'DOSSIER', 'BOARD_PACK', 'CONTENT', 'OTHER');

-- CreateTable
CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "avatar_path" TEXT NOT NULL,
    "persona_prompt" TEXT NOT NULL,
    "model_config" TEXT NOT NULL DEFAULT 'gemini-3.8-flash',
    "status_line" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_threads" (
    "id" TEXT NOT NULL,
    "type" "TeamThreadType" NOT NULL,
    "title" TEXT,
    "member_slug" TEXT,
    "topic" TEXT,
    "decision" TEXT,
    "decision_at" TIMESTAMP(3),
    "context_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_messages" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "author_type" "TeamAuthorType" NOT NULL,
    "author_slug" TEXT,
    "label" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_items" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "owner_slug" TEXT NOT NULL,
    "status" "WorkItemStatus" NOT NULL DEFAULT 'QUEUED',
    "source_thread_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_drafts" (
    "id" TEXT NOT NULL,
    "member_slug" TEXT NOT NULL,
    "kind" "TeamDraftKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source_thread_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_tool_logs" (
    "id" TEXT NOT NULL,
    "member_slug" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "input_summary" TEXT NOT NULL,
    "result_summary" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_tool_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_notes" (
    "id" TEXT NOT NULL,
    "member_slug" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "failure_cases" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "call_log_id" TEXT,
    "checks_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failure_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_page_watches" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "last_checked_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_page_watches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_members_slug_key" ON "team_members"("slug");

-- CreateIndex
CREATE INDEX "team_threads_type_idx" ON "team_threads"("type");

-- CreateIndex
CREATE INDEX "team_messages_thread_id_created_at_idx" ON "team_messages"("thread_id", "created_at");

-- CreateIndex
CREATE INDEX "work_items_status_created_at_idx" ON "work_items"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "team_drafts_created_at_idx" ON "team_drafts"("created_at" DESC);

-- CreateIndex
CREATE INDEX "team_tool_logs_created_at_idx" ON "team_tool_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "team_notes_member_slug_created_at_idx" ON "team_notes"("member_slug", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "team_page_watches_url_key" ON "team_page_watches"("url");

-- AddForeignKey
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "team_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
