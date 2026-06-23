-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Industry" AS ENUM ('CLINIC', 'CONSTRUCTION');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'AGENT');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('COMPLETED', 'FORWARDED', 'VOICEMAIL', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('VOICE_AGENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "CalendarProvider" AS ENUM ('GOOGLE', 'MICROSOFT');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'NOTIFIED', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobUrgency" AS ENUM ('EMERGENCY', 'URGENT', 'ROUTINE');

-- CreateEnum
CREATE TYPE "FsmProvider" AS ENUM ('SERVICETITAN', 'JOBBER', 'HOUSECALL');

-- CreateEnum
CREATE TYPE "FsmConnectionStatus" AS ENUM ('CONNECTED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('NOTIFYING', 'ACCEPTED', 'EXHAUSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DispatchAttemptStatus" AS ENUM ('CALLING', 'NO_ANSWER', 'DECLINED', 'ACCEPTED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('NEW', 'CONTACTED', 'SCHEDULED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('ADMIN', 'SUPPORT');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "industry" "Industry" NOT NULL,
    "subscription_status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "markup_bps" INTEGER NOT NULL DEFAULT 5000,
    "monthly_minute_limit" INTEGER NOT NULL DEFAULT 500,
    "multi_provider_enabled" BOOLEAN NOT NULL DEFAULT false,
    "multi_provider_self_manage" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'OWNER',
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_status" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "has_configured_profile" BOOLEAN NOT NULL DEFAULT false,
    "has_configured_prompt" BOOLEAN NOT NULL DEFAULT false,
    "has_tested_voice" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "assistant_id" TEXT,
    "display_name" TEXT NOT NULL DEFAULT 'Maya',
    "system_prompt" TEXT NOT NULL,
    "first_message" TEXT NOT NULL,
    "voicemail_greeting" TEXT NOT NULL,
    "business_hours" JSONB NOT NULL,
    "forwarding_numbers" JSONB NOT NULL DEFAULT '[]',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "inbound_phone_number" TEXT,
    "voice_provider" TEXT NOT NULL DEFAULT 'vapi',
    "voice_id" TEXT NOT NULL DEFAULT 'Emma',
    "background_sound" TEXT NOT NULL DEFAULT 'office',
    "offer_provider_choice" BOOLEAN NOT NULL DEFAULT false,
    "avg_appointment_value" INTEGER NOT NULL DEFAULT 150,
    "reject_anonymous_callers" BOOLEAN NOT NULL DEFAULT false,
    "max_call_duration_seconds" INTEGER NOT NULL DEFAULT 600,
    "silence_timeout_seconds" INTEGER NOT NULL DEFAULT 30,
    "wrap_up_message" TEXT,
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sms_confirmation" BOOLEAN NOT NULL DEFAULT true,
    "sms_reminder_24h" BOOLEAN NOT NULL DEFAULT true,
    "sms_reminder_1h" BOOLEAN NOT NULL DEFAULT false,
    "sms_confirmation_template" TEXT,
    "sms_reminder_24h_template" TEXT,
    "sms_reminder_1h_template" TEXT,
    "sms_waitlist" BOOLEAN NOT NULL DEFAULT true,
    "sms_waitlist_template" TEXT,
    "reactivation_enabled" BOOLEAN NOT NULL DEFAULT false,
    "reactivation_inactivity_days" INTEGER NOT NULL DEFAULT 180,
    "reactivation_template" TEXT,
    "emergency_alert_phone" TEXT,
    "on_call_roster" JSONB NOT NULL DEFAULT '[]',
    "dispatch_escalation_seconds" INTEGER NOT NULL DEFAULT 120,
    "missed_call_template" TEXT,
    "service_area_zips" JSONB NOT NULL DEFAULT '[]',
    "service_area_note" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 30,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_id" TEXT,
    "service_id" TEXT,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT,
    "reason" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "source" "AppointmentSource" NOT NULL DEFAULT 'VOICE_AGENT',
    "external_call_id" TEXT,
    "external_event_ids" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "demo_session_id" TEXT,
    "confirmation_sent_at" TIMESTAMP(3),
    "reminder_24h_sent_at" TIMESTAMP(3),
    "reminder_1h_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT NOT NULL,
    "provider_id" TEXT,
    "service_id" TEXT,
    "note" TEXT,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reactivation_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reactivation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_features" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "entitled" BOOLEAN NOT NULL DEFAULT false,
    "selfManage" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT,
    "service_address" TEXT,
    "job_type" TEXT,
    "urgency" "JobUrgency" NOT NULL DEFAULT 'ROUTINE',
    "description" TEXT,
    "preferred_callback" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'NEW',
    "source" "AppointmentSource" NOT NULL DEFAULT 'VOICE_AGENT',
    "external_call_id" TEXT,
    "notes" TEXT,
    "demo_session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatches" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "job_request_id" TEXT NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'NOTIFYING',
    "current_index" INTEGER NOT NULL DEFAULT 0,
    "roster" JSONB NOT NULL,
    "accepted_name" TEXT,
    "accepted_phone" TEXT,
    "token" TEXT NOT NULL,
    "escalate_after_sec" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_attempts" (
    "id" TEXT NOT NULL,
    "dispatch_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "contact_name" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "status" "DispatchAttemptStatus" NOT NULL DEFAULT 'CALLING',
    "call_sid" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatch_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fsm_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "FsmProvider" NOT NULL,
    "credentials_enc" TEXT NOT NULL,
    "account_label" TEXT,
    "status" "FsmConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "last_error" TEXT,
    "push_jobs" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fsm_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "CalendarProvider" NOT NULL,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "account_email" TEXT,
    "calendar_id" TEXT NOT NULL DEFAULT 'primary',
    "write_enabled" BOOLEAN NOT NULL DEFAULT true,
    "block_busy" BOOLEAN NOT NULL DEFAULT true,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "vapi_file_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pooled_numbers" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vapi_phone_id" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "assigned_tenant_id" TEXT,
    "assigned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pooled_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "place_id" TEXT,
    "business_name" TEXT NOT NULL,
    "trade" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "phone" TEXT,
    "website" TEXT,
    "address" TEXT,
    "email" TEXT,
    "email_source" TEXT,
    "rating" DOUBLE PRECISION,
    "review_count" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value_enc" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL DEFAULT 'SUPPORT',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "email" TEXT,
    "created_by" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "used_by_tenant_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "admin_email" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "external_call_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'phone',
    "caller_number" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "provider_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "billed_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "markup_bps_applied" INTEGER NOT NULL DEFAULT 0,
    "status" "CallStatus" NOT NULL DEFAULT 'UNKNOWN',
    "ended_reason" TEXT,
    "textback_sent_at" TIMESTAMP(3),
    "summary" TEXT,
    "transcript" TEXT,
    "recording_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_leads" (
    "id" TEXT NOT NULL,
    "demo_session_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "ip_country" TEXT,
    "phone_country" TEXT,
    "industry" TEXT NOT NULL DEFAULT 'other',
    "business_name" TEXT,
    "mode" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_opt_outs" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_opt_outs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_callers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_callers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screened_call_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "caller_number" TEXT,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screened_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_calls" (
    "id" TEXT NOT NULL,
    "demo_session_id" TEXT NOT NULL,
    "external_call_id" TEXT,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "ended_reason" TEXT,
    "summary" TEXT,
    "transcript" TEXT,
    "recording_url" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ProviderServices" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ProviderServices_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_status_tenant_id_key" ON "onboarding_status"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_settings_tenant_id_key" ON "agent_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_settings_inbound_phone_number_key" ON "agent_settings"("inbound_phone_number");

-- CreateIndex
CREATE INDEX "providers_tenant_id_idx" ON "providers"("tenant_id");

-- CreateIndex
CREATE INDEX "services_tenant_id_idx" ON "services"("tenant_id");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_starts_at_idx" ON "appointments"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_provider_id_idx" ON "appointments"("provider_id");

-- CreateIndex
CREATE INDEX "appointments_demo_session_id_idx" ON "appointments"("demo_session_id");

-- CreateIndex
CREATE INDEX "waitlist_tenant_id_status_idx" ON "waitlist"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "waitlist_provider_id_idx" ON "waitlist"("provider_id");

-- CreateIndex
CREATE INDEX "reactivation_logs_tenant_id_phone_sent_at_idx" ON "reactivation_logs"("tenant_id", "phone", "sent_at");

-- CreateIndex
CREATE INDEX "tenant_features_tenant_id_idx" ON "tenant_features"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_features_tenant_id_feature_key" ON "tenant_features"("tenant_id", "feature");

-- CreateIndex
CREATE INDEX "job_requests_tenant_id_status_created_at_idx" ON "job_requests"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "job_requests_tenant_id_urgency_idx" ON "job_requests"("tenant_id", "urgency");

-- CreateIndex
CREATE INDEX "dispatches_tenant_id_status_idx" ON "dispatches"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "dispatches_status_updated_at_idx" ON "dispatches"("status", "updated_at");

-- CreateIndex
CREATE INDEX "dispatch_attempts_dispatch_id_idx" ON "dispatch_attempts"("dispatch_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_attempts_dispatch_id_index_key" ON "dispatch_attempts"("dispatch_id", "index");

-- CreateIndex
CREATE INDEX "fsm_connections_tenant_id_idx" ON "fsm_connections"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "fsm_connections_tenant_id_provider_key" ON "fsm_connections"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "calendar_connections_tenant_id_idx" ON "calendar_connections"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_tenant_id_provider_key" ON "calendar_connections"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "documents_tenant_id_idx" ON "documents"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "pooled_numbers_number_key" ON "pooled_numbers"("number");

-- CreateIndex
CREATE UNIQUE INDEX "pooled_numbers_assigned_tenant_id_key" ON "pooled_numbers"("assigned_tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_place_id_key" ON "leads"("place_id");

-- CreateIndex
CREATE INDEX "leads_status_created_at_idx" ON "leads"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "leads_trade_city_idx" ON "leads"("trade", "city");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "access_codes_code_key" ON "access_codes"("code");

-- CreateIndex
CREATE INDEX "access_codes_created_at_idx" ON "access_codes"("created_at" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "call_logs_external_call_id_key" ON "call_logs"("external_call_id");

-- CreateIndex
CREATE INDEX "call_logs_tenant_id_started_at_idx" ON "call_logs"("tenant_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "demo_leads_demo_session_id_idx" ON "demo_leads"("demo_session_id");

-- CreateIndex
CREATE INDEX "demo_leads_created_at_idx" ON "demo_leads"("created_at" DESC);

-- CreateIndex
CREATE INDEX "sms_opt_outs_tenant_id_idx" ON "sms_opt_outs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_opt_outs_phone_tenant_id_key" ON "sms_opt_outs"("phone", "tenant_id");

-- CreateIndex
CREATE INDEX "blocked_callers_tenant_id_idx" ON "blocked_callers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_callers_tenant_id_phone_key" ON "blocked_callers"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "screened_call_logs_tenant_id_created_at_idx" ON "screened_call_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "demo_calls_external_call_id_key" ON "demo_calls"("external_call_id");

-- CreateIndex
CREATE INDEX "demo_calls_demo_session_id_idx" ON "demo_calls"("demo_session_id");

-- CreateIndex
CREATE INDEX "demo_calls_created_at_idx" ON "demo_calls"("created_at" DESC);

-- CreateIndex
CREATE INDEX "_ProviderServices_B_index" ON "_ProviderServices"("B");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_status" ADD CONSTRAINT "onboarding_status_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "providers" ADD CONSTRAINT "providers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reactivation_logs" ADD CONSTRAINT "reactivation_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_requests" ADD CONSTRAINT "job_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_job_request_id_fkey" FOREIGN KEY ("job_request_id") REFERENCES "job_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_attempts" ADD CONSTRAINT "dispatch_attempts_dispatch_id_fkey" FOREIGN KEY ("dispatch_id") REFERENCES "dispatches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fsm_connections" ADD CONSTRAINT "fsm_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_callers" ADD CONSTRAINT "blocked_callers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screened_call_logs" ADD CONSTRAINT "screened_call_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProviderServices" ADD CONSTRAINT "_ProviderServices_A_fkey" FOREIGN KEY ("A") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProviderServices" ADD CONSTRAINT "_ProviderServices_B_fkey" FOREIGN KEY ("B") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

