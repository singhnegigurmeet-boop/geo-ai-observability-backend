--
-- PostgreSQL database dump
--

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: analysis_execution_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.analysis_execution_status AS ENUM (
    'queued',
    'processing',
    'paused_budget',
    'completed',
    'partial_success',
    'failed',
    'cancelled'
);


--
-- Name: analysis_run_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.analysis_run_source AS ENUM (
    'manual',
    'scheduled'
);

--
-- Name: category_selection_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.category_selection_mode AS ENUM (
    'all',
    'selected'
);


--
-- Name: classification_job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.classification_job_status AS ENUM (
    'queued',
    'processing',
    'completed',
    'completed_empty',
    'invalid',
    'failed',
    'cancelled'
);


--
-- Name: budget_limit_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.budget_limit_mode AS ENUM (
    'hard',
    'soft'
);


--
-- Name: budget_scope; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.budget_scope AS ENUM (
    'platform_default',
    'workspace',
    'user',
    'anonymous_session',
    'analysis_run'
);


--
-- Name: entity_path_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.entity_path_type AS ENUM (
    'domain',
    'category',
    'brand',
    'product',
    'use_context'
);


--
-- Name: failure_record_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.failure_record_status AS ENUM (
    'open',
    'acknowledged',
    'resolved'
);


--
-- Name: job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_status AS ENUM (
    'pending',
    'queued',
    'processing',
    'paused_budget',
    'succeeded',
    'failed',
    'cancelled'
);


--
-- Name: notification_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_channel AS ENUM (
    'internal',
    'email',
    'webhook'
);


--
-- Name: notification_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_status AS ENUM (
    'pending',
    'queued',
    'sent',
    'failed',
    'cancelled'
);


--
-- Name: outbox_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.outbox_status AS ENUM (
    'pending',
    'publishing',
    'published',
    'failed'
);


--
-- Name: prompt_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.prompt_type AS ENUM (
    'competitor',
    'ranking',
    'visibility',
    'price_range',
    'pros_cons'
);


--
-- Name: provider_name; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provider_name AS ENUM (
    'mock',
    'openai',
    'gemini',
    'claude'
);


--
-- Name: provider_result_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provider_result_status AS ENUM (
    'valid',
    'invalid'
);

--
-- Name: context_validation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.context_validation_status AS ENUM (
    'valid',
    'invalid',
    'not_applicable'
);


--
-- Name: prompt_depth; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.prompt_depth AS ENUM (
    'weak',
    'medium',
    'high'
);


--
-- Name: provider_job_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provider_job_kind AS ENUM (
    'normal_prompt',
    'domain_category_classification'
);


--
-- Name: provider_score_metric_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provider_score_metric_type AS ENUM (
    'visibility',
    'ranking',
    'competitive_pressure'
);


--
-- Name: report_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.report_status AS ENUM (
    'completed',
    'partial',
    'failed'
);


--
-- Name: scheduler_job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.scheduler_job_status AS ENUM (
    'active',
    'paused',
    'disabled'
);


--
-- Name: session_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.session_status AS ENUM (
    'active',
    'revoked',
    'expired'
);


--
-- Name: token_usage_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.token_usage_kind AS ENUM (
    'estimated',
    'actual'
);


--
-- Name: user_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_status AS ENUM (
    'active',
    'disabled',
    'deleted'
);


--
-- Name: workspace_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.workspace_role AS ENUM (
    'owner',
    'admin',
    'member',
    'viewer'
);


--
-- Name: workspace_role_change_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.workspace_role_change_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'cancelled'
);


--
-- Name: create_notification_outbox(text, bigint, bigint, bigint, bigint, boolean, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_notification_outbox(notification_key text, notification_user_id bigint, notification_workspace_id bigint, notification_analysis_run_id bigint, notification_failure_record_id bigint, admin_notification boolean, notification_payload jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  created_notification_id bigint;
BEGIN
  INSERT INTO public.notifications (
    idempotency_key,
    user_id,
    workspace_id,
    analysis_run_id,
    failure_record_id,
    is_admin_notification,
    channel,
    payload
  )
  VALUES (
    notification_key,
    notification_user_id,
    notification_workspace_id,
    notification_analysis_run_id,
    notification_failure_record_id,
    admin_notification,
    'internal',
    notification_payload
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING notification_id INTO created_notification_id;

  IF created_notification_id IS NOT NULL THEN
    INSERT INTO public.outbox_events (
      event_key,
      aggregate_type,
      aggregate_id,
      event_type,
      event_version,
      payload,
      headers
    )
    VALUES (
      'notification.created:' || created_notification_id,
      'notification',
      created_notification_id::text,
      'notification.created',
      1,
      jsonb_build_object('notificationId', created_notification_id::text),
      jsonb_build_object('queueName', 'notification_queue')
    )
    ON CONFLICT (event_key) DO NOTHING;
  END IF;
END;
$$;


--
-- Name: enforce_provider_job_rendered_prompt(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_provider_job_rendered_prompt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.job_kind = 'normal_prompt' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.prompt_jobs
      WHERE prompt_job_id = NEW.prompt_job_id
        AND prompt_text IS NOT NULL
        AND length(btrim(prompt_text)) > 0
    ) THEN
      RAISE EXCEPTION 'normal provider job requires a rendered nonblank prompt'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.job_kind = 'domain_category_classification' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.domain_category_classification_jobs
      WHERE domain_category_classification_job_id = NEW.classification_job_id
        AND rendered_prompt IS NOT NULL
        AND length(btrim(rendered_prompt)) > 0
    ) THEN
      RAISE EXCEPTION 'classification provider job requires a rendered nonblank prompt'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: notify_analysis_cancelled(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_provider_job_execution_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status <> 'pending'
     AND (
       NEW.job_kind IS DISTINCT FROM OLD.job_kind
       OR NEW.prompt_job_id IS DISTINCT FROM OLD.prompt_job_id
       OR NEW.classification_job_id IS DISTINCT FROM OLD.classification_job_id
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.model IS DISTINCT FROM OLD.model
       OR NEW.response_contract_version IS DISTINCT FROM OLD.response_contract_version
       OR NEW.provider_instruction_profile IS DISTINCT FROM OLD.provider_instruction_profile
       OR NEW.model_profile_version IS DISTINCT FROM OLD.model_profile_version
       OR NEW.structured_output_mode IS DISTINCT FROM OLD.structured_output_mode
       OR NEW.request_payload IS DISTINCT FROM OLD.request_payload
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     ) THEN
    RAISE EXCEPTION 'provider job execution identity is immutable after queueing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


CREATE FUNCTION public.preserve_classification_job_execution_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.analysis_run_id IS DISTINCT FROM OLD.analysis_run_id
     OR NEW.domain_id IS DISTINCT FROM OLD.domain_id
     OR NEW.candidate_set_hash IS DISTINCT FROM OLD.candidate_set_hash
     OR NEW.classifier_provider IS DISTINCT FROM OLD.classifier_provider
     OR NEW.classifier_model IS DISTINCT FROM OLD.classifier_model
     OR NEW.model_profile_version IS DISTINCT FROM OLD.model_profile_version
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
     OR NEW.response_contract_version IS DISTINCT FROM OLD.response_contract_version
     OR NEW.provider_instruction_profile IS DISTINCT FROM OLD.provider_instruction_profile
     OR NEW.structured_output_mode IS DISTINCT FROM OLD.structured_output_mode
     OR NEW.input_payload IS DISTINCT FROM OLD.input_payload
     OR NEW.candidate_count IS DISTINCT FROM OLD.candidate_count
     OR (
       OLD.rendered_prompt IS NOT NULL
       AND NEW.rendered_prompt IS DISTINCT FROM OLD.rendered_prompt
     ) THEN
    RAISE EXCEPTION 'classification execution identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


CREATE FUNCTION public.notify_analysis_cancelled() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status = 'cancelled'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.user_id IS NOT NULL
     AND NEW.workspace_id IS NOT NULL THEN
    PERFORM public.create_notification_outbox(
      'notification:analysis_cancelled:' || NEW.analysis_run_id,
      NEW.user_id,
      NEW.workspace_id,
      NEW.analysis_run_id,
      NULL,
      false,
      jsonb_build_object(
        'type', 'analysis_cancelled',
        'analysisRunId', NEW.analysis_run_id::text
      )
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: notify_budget_paused(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_budget_paused() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status = 'paused_budget'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.user_id IS NOT NULL
     AND NEW.workspace_id IS NOT NULL THEN
    PERFORM public.create_notification_outbox(
      'notification:budget_paused:' || NEW.analysis_run_id,
      NEW.user_id,
      NEW.workspace_id,
      NEW.analysis_run_id,
      NULL,
      false,
      jsonb_build_object(
        'type', 'budget_paused',
        'analysisRunId', NEW.analysis_run_id::text
      )
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: notify_report_ready(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_report_ready() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  run_record public.analysis_runs%ROWTYPE;
BEGIN
  SELECT * INTO run_record
  FROM public.analysis_runs
  WHERE analysis_run_id = NEW.analysis_run_id;

  IF run_record.user_id IS NOT NULL AND run_record.workspace_id IS NOT NULL THEN
    PERFORM public.create_notification_outbox(
      'notification:report_ready:' || NEW.report_id,
      run_record.user_id,
      run_record.workspace_id,
      NEW.analysis_run_id,
      NULL,
      false,
      jsonb_build_object(
        'type', 'report_ready',
        'analysisRunId', NEW.analysis_run_id::text,
        'reportId', NEW.report_id::text,
        'reportVersion', NEW.report_version,
        'revision', NEW.revision,
        'reportStatus', NEW.status::text
      )
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: notify_terminal_failure(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_terminal_failure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.attempt_number = 3
     OR NEW.error_details ->> 'permanent' = 'true' THEN
    PERFORM public.create_notification_outbox(
      'notification:technical_failure:' || NEW.failure_record_id,
      NULL,
      NULL,
      NULL,
      NEW.failure_record_id,
      true,
      jsonb_build_object(
        'type', 'technical_failure',
        'failureRecordId', NEW.failure_record_id::text,
        'queueName', NEW.queue_name,
        'errorCode', NEW.error_code
      )
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: preserve_analysis_run_anonymous_origin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_analysis_run_anonymous_origin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.anonymous_session_id IS DISTINCT FROM OLD.anonymous_session_id THEN
    RAISE EXCEPTION 'analysis_runs.anonymous_session_id is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: preserve_anonymous_session_claim(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_anonymous_session_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.claimed_by_user_id IS NOT NULL
     AND (
       NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id
       OR NEW.claimed_workspace_id IS DISTINCT FROM OLD.claimed_workspace_id
       OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     ) THEN
    RAISE EXCEPTION 'anonymous session claim is immutable once set'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: reject_immutable_evidence_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_immutable_evidence_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;


--
-- Name: validate_analysis_run_anonymous_claim(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_analysis_run_anonymous_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.anonymous_session_id IS NOT NULL AND NEW.user_id IS NOT NULL THEN
    PERFORM 1
    FROM anonymous_sessions
    WHERE anonymous_session_id = NEW.anonymous_session_id
      AND claimed_by_user_id = NEW.user_id
      AND claimed_workspace_id = NEW.workspace_id
      AND claimed_at IS NOT NULL
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'claimed analysis run ownership must match its anonymous session claim'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: analysis_run_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_run_items (
    analysis_run_item_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    analysis_run_id bigint NOT NULL,
    entity_path_id bigint NOT NULL,
    item_ordinal integer NOT NULL,
    status public.analysis_execution_status DEFAULT 'queued'::public.analysis_execution_status NOT NULL,
    error_code text,
    error_message text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_run_items_completion_check CHECK ((((status = ANY (ARRAY['completed'::public.analysis_execution_status, 'partial_success'::public.analysis_execution_status, 'failed'::public.analysis_execution_status, 'cancelled'::public.analysis_execution_status])) AND (completed_at IS NOT NULL)) OR ((status <> ALL (ARRAY['completed'::public.analysis_execution_status, 'partial_success'::public.analysis_execution_status, 'failed'::public.analysis_execution_status, 'cancelled'::public.analysis_execution_status])) AND (completed_at IS NULL)))),
    CONSTRAINT analysis_run_items_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT analysis_run_items_ordinal_check CHECK ((item_ordinal >= 0))
);


--
-- Name: analysis_run_items_analysis_run_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analysis_run_items ALTER COLUMN analysis_run_item_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analysis_run_items_analysis_run_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analysis_run_provider_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_run_provider_models (
    analysis_run_provider_model_id bigint NOT NULL,
    analysis_run_id bigint NOT NULL,
    provider public.provider_name NOT NULL,
    model text NOT NULL,
    model_profile_version text NOT NULL,
    ordinal integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_run_provider_models_model_not_blank_check CHECK ((length(btrim(model)) > 0)),
    CONSTRAINT analysis_run_provider_models_profile_not_blank_check CHECK ((length(btrim(model_profile_version)) > 0)),
    CONSTRAINT analysis_run_provider_models_ordinal_check CHECK ((ordinal >= 0))
);

--
-- Name: analysis_run_requested_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_run_requested_categories (
    analysis_run_requested_category_id bigint NOT NULL,
    analysis_run_id bigint NOT NULL,
    category_id bigint NOT NULL,
    ordinal integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_run_requested_categories_ordinal_check CHECK ((ordinal >= 0))
);


ALTER TABLE public.analysis_run_requested_categories ALTER COLUMN analysis_run_requested_category_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analysis_run_requested_categories_analysis_run_requested_category_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analysis_run_provider_models_analysis_run_provider_model_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analysis_run_provider_models ALTER COLUMN analysis_run_provider_model_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analysis_run_provider_models_analysis_run_provider_model_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analysis_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_runs (
    analysis_run_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    anonymous_session_id bigint,
    user_id bigint,
    workspace_id bigint,
    starting_entity_path_id bigint NOT NULL,
    category_selection_mode public.category_selection_mode NOT NULL,
    prompt_depth public.prompt_depth NOT NULL,
    prompt_policy_version text NOT NULL,
    source public.analysis_run_source DEFAULT 'manual'::public.analysis_run_source NOT NULL,
    status public.analysis_execution_status DEFAULT 'queued'::public.analysis_execution_status NOT NULL,
    request_payload jsonb NOT NULL,
    error_code text,
    error_message text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_runs_completion_check CHECK ((((status = ANY (ARRAY['completed'::public.analysis_execution_status, 'partial_success'::public.analysis_execution_status, 'failed'::public.analysis_execution_status, 'cancelled'::public.analysis_execution_status])) AND (completed_at IS NOT NULL)) OR ((status <> ALL (ARRAY['completed'::public.analysis_execution_status, 'partial_success'::public.analysis_execution_status, 'failed'::public.analysis_execution_status, 'cancelled'::public.analysis_execution_status])) AND (completed_at IS NULL)))),
    CONSTRAINT analysis_runs_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT analysis_runs_ownership_check CHECK ((((anonymous_session_id IS NOT NULL) AND (user_id IS NULL) AND (workspace_id IS NULL)) OR ((user_id IS NOT NULL) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT analysis_runs_prompt_policy_not_blank_check CHECK ((length(btrim(prompt_policy_version)) > 0)),
    CONSTRAINT analysis_runs_request_payload_object_check CHECK ((jsonb_typeof(request_payload) = 'object'::text))
);


--
-- Name: analysis_runs_analysis_run_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analysis_runs ALTER COLUMN analysis_run_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analysis_runs_analysis_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: anonymous_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anonymous_sessions (
    anonymous_session_id bigint NOT NULL,
    token_hash text NOT NULL,
    status public.session_status DEFAULT 'active'::public.session_status NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone,
    claimed_by_user_id bigint,
    claimed_workspace_id bigint,
    claimed_at timestamp with time zone,
    client_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT anonymous_sessions_claim_state_check CHECK ((((claimed_by_user_id IS NULL) AND (claimed_workspace_id IS NULL) AND (claimed_at IS NULL)) OR ((claimed_by_user_id IS NOT NULL) AND (claimed_workspace_id IS NOT NULL) AND (claimed_at IS NOT NULL)))),
    CONSTRAINT anonymous_sessions_client_metadata_object_check CHECK ((jsonb_typeof(client_metadata) = 'object'::text)),
    CONSTRAINT anonymous_sessions_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT anonymous_sessions_token_hash_not_blank_check CHECK ((length(btrim(token_hash)) > 0))
);


--
-- Name: anonymous_sessions_anonymous_session_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.anonymous_sessions ALTER COLUMN anonymous_session_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.anonymous_sessions_anonymous_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: brand_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_products (
    brand_product_id bigint NOT NULL,
    category_brand_id bigint NOT NULL,
    product_id bigint NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brand_products_brand_product_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.brand_products ALTER COLUMN brand_product_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.brand_products_brand_product_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: brands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brands (
    brand_id bigint NOT NULL,
    brand_name text NOT NULL,
    normalized_name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brands_name_not_blank_check CHECK ((length(btrim(brand_name)) > 0)),
    CONSTRAINT brands_normalized_check CHECK (((length(btrim(normalized_name)) > 0) AND (normalized_name = lower(btrim(normalized_name)))))
);


--
-- Name: brands_brand_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.brands ALTER COLUMN brand_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.brands_brand_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: budget_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_policies (
    budget_policy_id bigint NOT NULL,
    budget_scope public.budget_scope NOT NULL,
    workspace_id bigint,
    provider public.provider_name NOT NULL,
    limit_mode public.budget_limit_mode NOT NULL,
    window_seconds integer NOT NULL,
    token_limit bigint,
    cost_limit_micros bigint,
    currency_code character(3) DEFAULT 'USD'::bpchar NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id bigint,
    anonymous_session_id bigint,
    analysis_run_id bigint,
    model text,
    CONSTRAINT budget_policies_currency_check CHECK (((currency_code)::text = upper((currency_code)::text))),
    CONSTRAINT budget_policies_limit_check CHECK ((((token_limit IS NOT NULL) OR (cost_limit_micros IS NOT NULL)) AND ((token_limit IS NULL) OR (token_limit > 0)) AND ((cost_limit_micros IS NULL) OR (cost_limit_micros > 0)))),
    CONSTRAINT budget_policies_model_not_blank_check CHECK (((model IS NULL) OR (length(btrim(model)) > 0))),
    CONSTRAINT budget_policies_scope_check CHECK ((((budget_scope = 'platform_default'::public.budget_scope) AND (workspace_id IS NULL) AND (user_id IS NULL) AND (anonymous_session_id IS NULL) AND (analysis_run_id IS NULL)) OR ((budget_scope = 'workspace'::public.budget_scope) AND (workspace_id IS NOT NULL) AND (user_id IS NULL) AND (anonymous_session_id IS NULL) AND (analysis_run_id IS NULL)) OR ((budget_scope = 'user'::public.budget_scope) AND (workspace_id IS NULL) AND (user_id IS NOT NULL) AND (anonymous_session_id IS NULL) AND (analysis_run_id IS NULL)) OR ((budget_scope = 'anonymous_session'::public.budget_scope) AND (workspace_id IS NULL) AND (user_id IS NULL) AND (anonymous_session_id IS NOT NULL) AND (analysis_run_id IS NULL)) OR ((budget_scope = 'analysis_run'::public.budget_scope) AND (workspace_id IS NULL) AND (user_id IS NULL) AND (anonymous_session_id IS NULL) AND (analysis_run_id IS NOT NULL)))),
    CONSTRAINT budget_policies_window_check CHECK ((window_seconds > 0))
);


--
-- Name: budget_policies_budget_policy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.budget_policies ALTER COLUMN budget_policy_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.budget_policies_budget_policy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    category_id bigint NOT NULL,
    category_name text NOT NULL,
    normalized_name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT categories_name_not_blank_check CHECK ((length(btrim(category_name)) > 0)),
    CONSTRAINT categories_normalized_check CHECK (((length(btrim(normalized_name)) > 0) AND (normalized_name = lower(btrim(normalized_name)))))
);


--
-- Name: categories_category_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.categories ALTER COLUMN category_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.categories_category_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: category_brands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.category_brands (
    category_brand_id bigint NOT NULL,
    domain_category_id bigint NOT NULL,
    brand_id bigint NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: category_brands_category_brand_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.category_brands ALTER COLUMN category_brand_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.category_brands_category_brand_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: domain_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domain_categories (
    domain_category_id bigint NOT NULL,
    domain_id bigint NOT NULL,
    category_id bigint NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer,
    source text DEFAULT 'manual'::text NOT NULL,
    classification_provider_result_id bigint,
    classification_rank integer,
    classification_confidence numeric(5,4),
    classified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT domain_categories_classification_provenance_check CHECK ((((source = ANY (ARRAY['manual'::text, 'import'::text])) AND (classification_provider_result_id IS NULL) AND (classification_rank IS NULL) AND (classification_confidence IS NULL) AND (classified_at IS NULL)) OR ((source = 'llm_classification'::text) AND (classification_provider_result_id IS NOT NULL) AND (classification_rank IS NOT NULL) AND (classification_rank > 0) AND (classification_confidence IS NOT NULL) AND (classification_confidence >= (0)::numeric) AND (classification_confidence <= (1)::numeric) AND (classified_at IS NOT NULL)))),
    CONSTRAINT domain_categories_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'import'::text, 'llm_classification'::text])))
);

--
-- Name: domain_category_classification_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domain_category_classification_jobs (
    domain_category_classification_job_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    analysis_run_id bigint NOT NULL,
    domain_id bigint NOT NULL,
    candidate_set_hash character(64) NOT NULL,
    status public.classification_job_status DEFAULT 'queued'::public.classification_job_status NOT NULL,
    classifier_provider public.provider_name NOT NULL,
    classifier_model text NOT NULL,
    model_profile_version text NOT NULL,
    prompt_version text NOT NULL,
    response_contract_version text NOT NULL,
    provider_instruction_profile text NOT NULL,
    structured_output_mode text NOT NULL,
    input_payload jsonb NOT NULL,
    rendered_prompt text,
    candidate_count integer NOT NULL,
    error_code text,
    error_message text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT classification_jobs_candidate_count_check CHECK ((candidate_count > 0)),
    CONSTRAINT classification_jobs_completion_check CHECK ((((status = ANY (ARRAY['completed'::public.classification_job_status, 'completed_empty'::public.classification_job_status, 'invalid'::public.classification_job_status, 'failed'::public.classification_job_status, 'cancelled'::public.classification_job_status])) AND (completed_at IS NOT NULL)) OR ((status = ANY (ARRAY['queued'::public.classification_job_status, 'processing'::public.classification_job_status])) AND (completed_at IS NULL)))),
    CONSTRAINT classification_jobs_hash_check CHECK ((candidate_set_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT classification_jobs_input_object_check CHECK ((jsonb_typeof(input_payload) = 'object'::text)),
    CONSTRAINT classification_jobs_nonblank_check CHECK (((length(btrim(idempotency_key)) > 0) AND (length(btrim(classifier_model)) > 0) AND (length(btrim(model_profile_version)) > 0) AND (length(btrim(prompt_version)) > 0) AND (length(btrim(response_contract_version)) > 0) AND (length(btrim(provider_instruction_profile)) > 0) AND (length(btrim(structured_output_mode)) > 0))),
    CONSTRAINT classification_jobs_rendered_state_check CHECK ((((status = 'queued'::public.classification_job_status) AND (rendered_prompt IS NULL)) OR ((status = ANY (ARRAY['failed'::public.classification_job_status, 'cancelled'::public.classification_job_status])) AND ((rendered_prompt IS NULL) OR (length(btrim(rendered_prompt)) > 0))) OR ((status = ANY (ARRAY['processing'::public.classification_job_status, 'completed'::public.classification_job_status, 'completed_empty'::public.classification_job_status, 'invalid'::public.classification_job_status])) AND (rendered_prompt IS NOT NULL) AND (length(btrim(rendered_prompt)) > 0))))
);


ALTER TABLE public.domain_category_classification_jobs ALTER COLUMN domain_category_classification_job_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.domain_category_classification_jobs_domain_category_classification_job_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: domain_categories_domain_category_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.domain_categories ALTER COLUMN domain_category_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.domain_categories_domain_category_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domains (
    domain_id bigint NOT NULL,
    normalized_domain text NOT NULL,
    display_domain text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT domains_display_normalized_check CHECK (((display_domain IS NULL) OR (display_domain = normalized_domain))),
    CONSTRAINT domains_normalized_format_check CHECK (((normalized_domain = lower(btrim(normalized_domain))) AND (normalized_domain !~ '[[:space:]/:]'::text) AND (normalized_domain ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'::text))),
    CONSTRAINT domains_normalized_not_blank_check CHECK (((length(normalized_domain) >= 1) AND (length(normalized_domain) <= 253)))
);


--
-- Name: domains_domain_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.domains ALTER COLUMN domain_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.domains_domain_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: entity_paths; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_paths (
    entity_path_id bigint NOT NULL,
    domain_id bigint NOT NULL,
    category_id bigint,
    brand_id bigint,
    product_id bigint,
    use_context_id bigint,
    path_type public.entity_path_type NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_paths_shape_check CHECK ((((path_type = 'domain'::public.entity_path_type) AND (category_id IS NULL) AND (brand_id IS NULL) AND (product_id IS NULL) AND (use_context_id IS NULL)) OR ((path_type = 'category'::public.entity_path_type) AND (category_id IS NOT NULL) AND (brand_id IS NULL) AND (product_id IS NULL) AND (use_context_id IS NULL)) OR ((path_type = 'brand'::public.entity_path_type) AND (category_id IS NOT NULL) AND (brand_id IS NOT NULL) AND (product_id IS NULL) AND (use_context_id IS NULL)) OR ((path_type = 'product'::public.entity_path_type) AND (category_id IS NOT NULL) AND (brand_id IS NOT NULL) AND (product_id IS NOT NULL) AND (use_context_id IS NULL)) OR ((path_type = 'use_context'::public.entity_path_type) AND (category_id IS NOT NULL) AND (brand_id IS NOT NULL) AND (product_id IS NOT NULL) AND (use_context_id IS NOT NULL))))
);


--
-- Name: entity_paths_entity_path_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.entity_paths ALTER COLUMN entity_path_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.entity_paths_entity_path_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: failure_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.failure_records (
    failure_record_id bigint NOT NULL,
    queue_name text NOT NULL,
    message_id text NOT NULL,
    aggregate_type text,
    aggregate_id text,
    attempt_number integer NOT NULL,
    error_code text,
    error_message text NOT NULL,
    error_details jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.failure_record_status DEFAULT 'open'::public.failure_record_status NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT failure_records_attempt_check CHECK (((attempt_number >= 1) AND (attempt_number <= 3))),
    CONSTRAINT failure_records_details_object_check CHECK ((jsonb_typeof(error_details) = 'object'::text)),
    CONSTRAINT failure_records_error_not_blank_check CHECK ((length(btrim(error_message)) > 0)),
    CONSTRAINT failure_records_message_not_blank_check CHECK ((length(btrim(message_id)) > 0)),
    CONSTRAINT failure_records_queue_not_blank_check CHECK ((length(btrim(queue_name)) > 0)),
    CONSTRAINT failure_records_resolution_check CHECK ((((status = 'open'::public.failure_record_status) AND (acknowledged_at IS NULL) AND (resolved_at IS NULL)) OR ((status = 'acknowledged'::public.failure_record_status) AND (acknowledged_at IS NOT NULL) AND (resolved_at IS NULL)) OR ((status = 'resolved'::public.failure_record_status) AND (acknowledged_at IS NOT NULL) AND (resolved_at IS NOT NULL))))
);


--
-- Name: failure_records_failure_record_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.failure_records ALTER COLUMN failure_record_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.failure_records_failure_record_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: llm_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_runs (
    llm_run_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    analysis_run_item_id bigint NOT NULL,
    run_key text DEFAULT 'primary'::text NOT NULL,
    status public.analysis_execution_status DEFAULT 'queued'::public.analysis_execution_status NOT NULL,
    error_code text,
    error_message text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT llm_runs_completion_check CHECK ((((status = ANY (ARRAY['completed'::public.analysis_execution_status, 'partial_success'::public.analysis_execution_status, 'failed'::public.analysis_execution_status, 'cancelled'::public.analysis_execution_status])) AND (completed_at IS NOT NULL)) OR ((status <> ALL (ARRAY['completed'::public.analysis_execution_status, 'partial_success'::public.analysis_execution_status, 'failed'::public.analysis_execution_status, 'cancelled'::public.analysis_execution_status])) AND (completed_at IS NULL)))),
    CONSTRAINT llm_runs_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT llm_runs_run_key_not_blank_check CHECK ((length(btrim(run_key)) > 0))
);


--
-- Name: llm_runs_llm_run_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.llm_runs ALTER COLUMN llm_run_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.llm_runs_llm_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    notification_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    user_id bigint,
    workspace_id bigint,
    analysis_run_id bigint,
    failure_record_id bigint,
    is_admin_notification boolean DEFAULT false NOT NULL,
    channel public.notification_channel NOT NULL,
    status public.notification_status DEFAULT 'pending'::public.notification_status NOT NULL,
    payload jsonb NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_attempt_count_check CHECK (((attempt_count >= 0) AND (attempt_count <= 3))),
    CONSTRAINT notifications_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT notifications_payload_object_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT notifications_recipient_check CHECK (((is_admin_notification AND (user_id IS NULL) AND (workspace_id IS NULL)) OR ((NOT is_admin_notification) AND ((user_id IS NOT NULL) OR (workspace_id IS NOT NULL))))),
    CONSTRAINT notifications_sent_state_check CHECK ((((status = 'sent'::public.notification_status) AND (sent_at IS NOT NULL)) OR ((status <> 'sent'::public.notification_status) AND (sent_at IS NULL))))
);


--
-- Name: notifications_notification_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.notifications ALTER COLUMN notification_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.notifications_notification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: outbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_events (
    outbox_event_id bigint NOT NULL,
    event_key text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    event_type text NOT NULL,
    event_version integer DEFAULT 1 NOT NULL,
    payload jsonb NOT NULL,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.outbox_status DEFAULT 'pending'::public.outbox_status NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    published_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_events_aggregate_id_not_blank_check CHECK ((length(btrim(aggregate_id)) > 0)),
    CONSTRAINT outbox_events_aggregate_type_not_blank_check CHECK ((length(btrim(aggregate_type)) > 0)),
    CONSTRAINT outbox_events_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT outbox_events_headers_object_check CHECK ((jsonb_typeof(headers) = 'object'::text)),
    CONSTRAINT outbox_events_key_not_blank_check CHECK ((length(btrim(event_key)) > 0)),
    CONSTRAINT outbox_events_lock_state_check CHECK ((((locked_at IS NULL) AND (locked_by IS NULL)) OR ((locked_at IS NOT NULL) AND (locked_by IS NOT NULL)))),
    CONSTRAINT outbox_events_payload_object_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT outbox_events_publish_state_check CHECK ((((status = 'published'::public.outbox_status) AND (published_at IS NOT NULL)) OR ((status <> 'published'::public.outbox_status) AND (published_at IS NULL)))),
    CONSTRAINT outbox_events_type_not_blank_check CHECK ((length(btrim(event_type)) > 0)),
    CONSTRAINT outbox_events_version_check CHECK ((event_version > 0))
);


--
-- Name: outbox_events_outbox_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.outbox_events ALTER COLUMN outbox_event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.outbox_events_outbox_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: product_use_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_use_contexts (
    product_use_context_id bigint NOT NULL,
    brand_product_id bigint NOT NULL,
    use_context_id bigint NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_use_contexts_product_use_context_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.product_use_contexts ALTER COLUMN product_use_context_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.product_use_contexts_product_use_context_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    product_id bigint NOT NULL,
    product_name text NOT NULL,
    normalized_name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT products_name_not_blank_check CHECK ((length(btrim(product_name)) > 0)),
    CONSTRAINT products_normalized_check CHECK (((length(btrim(normalized_name)) > 0) AND (normalized_name = lower(btrim(normalized_name)))))
);


--
-- Name: products_product_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.products ALTER COLUMN product_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.products_product_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: prompt_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_jobs (
    prompt_job_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    llm_run_id bigint NOT NULL,
    prompt_type public.prompt_type NOT NULL,
    prompt_depth public.prompt_depth NOT NULL,
    business_prompt_version text NOT NULL,
    response_contract_version text NOT NULL,
    status public.job_status DEFAULT 'pending'::public.job_status NOT NULL,
    prompt_text text,
    input_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    priority smallint DEFAULT 0 NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prompt_jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT prompt_jobs_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT prompt_jobs_input_payload_object_check CHECK ((jsonb_typeof(input_payload) = 'object'::text)),
    CONSTRAINT prompt_jobs_text_null_or_not_blank_check CHECK (((prompt_text IS NULL) OR (length(btrim(prompt_text)) > 0))),
    CONSTRAINT prompt_jobs_versions_not_blank_check CHECK (((length(btrim(business_prompt_version)) > 0) AND (length(btrim(response_contract_version)) > 0)))
);


--
-- Name: prompt_jobs_prompt_job_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.prompt_jobs ALTER COLUMN prompt_job_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.prompt_jobs_prompt_job_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: provider_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_jobs (
    provider_job_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    job_kind public.provider_job_kind NOT NULL,
    prompt_job_id bigint,
    classification_job_id bigint,
    provider public.provider_name NOT NULL,
    model text NOT NULL,
    response_contract_version text NOT NULL,
    provider_instruction_profile text NOT NULL,
    model_profile_version text NOT NULL,
    structured_output_mode text NOT NULL,
    request_hash character(64),
    status public.job_status DEFAULT 'pending'::public.job_status NOT NULL,
    request_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_jobs_attempts_check CHECK (((attempt_count >= 0) AND (max_attempts = 3) AND (attempt_count <= max_attempts))),
    CONSTRAINT provider_jobs_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT provider_jobs_identity_not_blank_check CHECK (((length(btrim(response_contract_version)) > 0) AND (length(btrim(provider_instruction_profile)) > 0) AND (length(btrim(model_profile_version)) > 0) AND (length(btrim(structured_output_mode)) > 0))),
    CONSTRAINT provider_jobs_kind_parent_check CHECK ((((job_kind = 'normal_prompt'::public.provider_job_kind) AND (prompt_job_id IS NOT NULL) AND (classification_job_id IS NULL)) OR ((job_kind = 'domain_category_classification'::public.provider_job_kind) AND (prompt_job_id IS NULL) AND (classification_job_id IS NOT NULL)))),
    CONSTRAINT provider_jobs_model_not_blank_check CHECK ((length(btrim(model)) > 0)),
    CONSTRAINT provider_jobs_request_hash_check CHECK (((request_hash IS NULL) OR (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT provider_jobs_request_payload_object_check CHECK ((jsonb_typeof(request_payload) = 'object'::text))
);


--
-- Name: provider_jobs_provider_job_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.provider_jobs ALTER COLUMN provider_job_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.provider_jobs_provider_job_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: provider_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_results (
    provider_result_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    provider_job_id bigint NOT NULL,
    provider public.provider_name NOT NULL,
    status public.provider_result_status NOT NULL,
    response_contract_version text NOT NULL,
    provider_request_id text,
    model_version text,
    raw_response text NOT NULL,
    raw_response_truncated boolean DEFAULT false NOT NULL,
    raw_response_original_bytes integer NOT NULL,
    provider_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    validated_response jsonb,
    validation_errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    context_validation_status public.context_validation_status NOT NULL,
    finish_reason text,
    latency_ms integer NOT NULL,
    received_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_results_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT provider_results_latency_check CHECK ((latency_ms >= 0)),
    CONSTRAINT provider_results_metadata_object_check CHECK ((jsonb_typeof(provider_metadata) = 'object'::text)),
    CONSTRAINT provider_results_raw_response_size_check CHECK (((octet_length(raw_response) <= 262144) AND (raw_response_original_bytes >= 0) AND (((NOT raw_response_truncated) AND (raw_response_original_bytes = octet_length(raw_response))) OR (raw_response_truncated AND (raw_response_original_bytes > octet_length(raw_response)))))),
    CONSTRAINT provider_results_response_contract_not_blank_check CHECK ((length(btrim(response_contract_version)) > 0)),
    CONSTRAINT provider_results_validation_errors_array_check CHECK ((jsonb_typeof(validation_errors) = 'array'::text)),
    CONSTRAINT provider_results_validation_state_check CHECK ((((status = 'valid'::public.provider_result_status) AND (validated_response IS NOT NULL) AND (validation_errors = '[]'::jsonb) AND (context_validation_status = ANY (ARRAY['valid'::public.context_validation_status, 'not_applicable'::public.context_validation_status]))) OR ((status = 'invalid'::public.provider_result_status) AND (validated_response IS NULL) AND (validation_errors <> '[]'::jsonb) AND (context_validation_status = 'invalid'::public.context_validation_status))))
);


--
-- Name: provider_results_provider_result_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.provider_results ALTER COLUMN provider_result_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.provider_results_provider_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: provider_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_scores (
    provider_score_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    provider_result_id bigint NOT NULL,
    metric_type public.provider_score_metric_type NOT NULL,
    scoring_version text NOT NULL,
    score numeric(7,4) NOT NULL,
    score_components jsonb DEFAULT '{}'::jsonb NOT NULL,
    calculated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_scores_components_object_check CHECK ((jsonb_typeof(score_components) = 'object'::text)),
    CONSTRAINT provider_scores_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT provider_scores_range_check CHECK (((score >= (0)::numeric) AND (score <= (100)::numeric))),
    CONSTRAINT provider_scores_version_not_blank_check CHECK ((length(btrim(scoring_version)) > 0))
);


--
-- Name: provider_scores_provider_score_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.provider_scores ALTER COLUMN provider_score_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.provider_scores_provider_score_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    report_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    analysis_run_id bigint NOT NULL,
    report_version text NOT NULL,
    status public.report_status NOT NULL,
    report_data jsonb NOT NULL,
    rendered_text text,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT reports_data_object_check CHECK ((jsonb_typeof(report_data) = 'object'::text)),
    CONSTRAINT reports_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT reports_revision_positive_check CHECK ((revision > 0)),
    CONSTRAINT reports_version_not_blank_check CHECK ((length(btrim(report_version)) > 0))
);


--
-- Name: reports_report_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.reports ALTER COLUMN report_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.reports_report_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: scheduler_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduler_jobs (
    scheduler_job_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    workspace_id bigint NOT NULL,
    created_by_user_id bigint NOT NULL,
    starting_entity_path_id bigint NOT NULL,
    category_selection_mode public.category_selection_mode NOT NULL,
    prompt_depth public.prompt_depth NOT NULL,
    prompt_policy_version text NOT NULL,
    job_name text NOT NULL,
    schedule_expression text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    status public.scheduler_job_status DEFAULT 'active'::public.scheduler_job_status NOT NULL,
    request_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    next_run_at timestamp with time zone NOT NULL,
    last_enqueued_at timestamp with time zone,
    last_analysis_run_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduler_jobs_expression_not_blank_check CHECK ((length(btrim(schedule_expression)) > 0)),
    CONSTRAINT scheduler_jobs_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT scheduler_jobs_name_not_blank_check CHECK ((length(btrim(job_name)) > 0)),
    CONSTRAINT scheduler_jobs_prompt_policy_not_blank_check CHECK ((length(btrim(prompt_policy_version)) > 0)),
    CONSTRAINT scheduler_jobs_payload_object_check CHECK ((jsonb_typeof(request_payload) = 'object'::text)),
    CONSTRAINT scheduler_jobs_timezone_not_blank_check CHECK ((length(btrim(timezone)) > 0))
);

--
-- Name: scheduler_job_requested_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduler_job_requested_categories (
    scheduler_job_requested_category_id bigint NOT NULL,
    scheduler_job_id bigint NOT NULL,
    category_id bigint NOT NULL,
    ordinal integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduler_job_requested_categories_ordinal_check CHECK ((ordinal >= 0))
);


ALTER TABLE public.scheduler_job_requested_categories ALTER COLUMN scheduler_job_requested_category_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.scheduler_job_requested_categories_scheduler_job_requested_category_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: scheduler_jobs_scheduler_job_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.scheduler_jobs ALTER COLUMN scheduler_job_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.scheduler_jobs_scheduler_job_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: token_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_usage (
    token_usage_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    provider_job_id bigint NOT NULL,
    usage_kind public.token_usage_kind NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cached_tokens bigint DEFAULT 0 NOT NULL,
    reasoning_tokens bigint DEFAULT 0 NOT NULL,
    total_tokens bigint GENERATED ALWAYS AS ((input_tokens + output_tokens)) STORED,
    cost_micros bigint,
    currency_code character(3) DEFAULT 'USD'::bpchar NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT token_usage_component_bounds_check CHECK (((cached_tokens <= input_tokens) AND (reasoning_tokens <= output_tokens))),
    CONSTRAINT token_usage_currency_check CHECK (((currency_code)::text = upper((currency_code)::text))),
    CONSTRAINT token_usage_idempotency_not_blank_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT token_usage_nonnegative_check CHECK (((input_tokens >= 0) AND (output_tokens >= 0) AND (cached_tokens >= 0) AND (reasoning_tokens >= 0) AND ((cost_micros IS NULL) OR (cost_micros >= 0))))
);


--
-- Name: token_usage_token_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.token_usage ALTER COLUMN token_usage_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.token_usage_token_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: use_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.use_contexts (
    use_context_id bigint NOT NULL,
    use_context_name text NOT NULL,
    normalized_name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT use_contexts_name_not_blank_check CHECK ((length(btrim(use_context_name)) > 0)),
    CONSTRAINT use_contexts_normalized_check CHECK (((length(btrim(normalized_name)) > 0) AND (normalized_name = lower(btrim(normalized_name)))))
);


--
-- Name: use_contexts_use_context_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.use_contexts ALTER COLUMN use_context_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.use_contexts_use_context_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    user_session_id bigint NOT NULL,
    user_id bigint NOT NULL,
    token_hash text NOT NULL,
    status public.session_status DEFAULT 'active'::public.session_status NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    client_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_sessions_client_metadata_object_check CHECK ((jsonb_typeof(client_metadata) = 'object'::text)),
    CONSTRAINT user_sessions_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT user_sessions_revocation_check CHECK ((((status = 'revoked'::public.session_status) AND (revoked_at IS NOT NULL)) OR (status <> 'revoked'::public.session_status))),
    CONSTRAINT user_sessions_token_hash_not_blank_check CHECK ((length(btrim(token_hash)) > 0))
);


--
-- Name: user_sessions_user_session_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_sessions ALTER COLUMN user_session_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.user_sessions_user_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    user_id bigint NOT NULL,
    email text NOT NULL,
    password_hash text,
    display_name text,
    status public.user_status DEFAULT 'active'::public.user_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT users_deleted_state_check CHECK ((((status = 'deleted'::public.user_status) AND (deleted_at IS NOT NULL)) OR ((status <> 'deleted'::public.user_status) AND (deleted_at IS NULL)))),
    CONSTRAINT users_email_normalized_check CHECK ((email = lower(btrim(email)))),
    CONSTRAINT users_email_not_blank_check CHECK ((length(btrim(email)) > 0))
);


--
-- Name: users_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.users ALTER COLUMN user_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.users_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    workspace_id bigint NOT NULL,
    user_id bigint NOT NULL,
    role public.workspace_role NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_role_change_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_role_change_requests (
    workspace_role_change_request_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    target_user_id bigint NOT NULL,
    requested_role public.workspace_role NOT NULL,
    requested_by_user_id bigint NOT NULL,
    reviewed_by_user_id bigint,
    status public.workspace_role_change_status DEFAULT 'pending'::public.workspace_role_change_status NOT NULL,
    request_reason text,
    review_note text,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_role_change_review_check CHECK ((((status = 'pending'::public.workspace_role_change_status) AND (reviewed_by_user_id IS NULL) AND (reviewed_at IS NULL)) OR ((status <> 'pending'::public.workspace_role_change_status) AND (reviewed_by_user_id IS NOT NULL) AND (reviewed_at IS NOT NULL))))
);


--
-- Name: workspace_role_change_request_workspace_role_change_request_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.workspace_role_change_requests ALTER COLUMN workspace_role_change_request_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.workspace_role_change_request_workspace_role_change_request_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    workspace_id bigint NOT NULL,
    workspace_name text NOT NULL,
    created_by_user_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT workspaces_name_not_blank_check CHECK ((length(btrim(workspace_name)) > 0))
);


--
-- Name: workspaces_workspace_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.workspaces ALTER COLUMN workspace_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.workspaces_workspace_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analysis_run_items analysis_run_items_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_items
    ADD CONSTRAINT analysis_run_items_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: analysis_run_items analysis_run_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_items
    ADD CONSTRAINT analysis_run_items_pkey PRIMARY KEY (analysis_run_item_id);


--
-- Name: analysis_run_items analysis_run_items_run_ordinal_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_items
    ADD CONSTRAINT analysis_run_items_run_ordinal_unique UNIQUE (analysis_run_id, item_ordinal);


--
-- Name: analysis_run_items analysis_run_items_run_path_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_items
    ADD CONSTRAINT analysis_run_items_run_path_unique UNIQUE (analysis_run_id, entity_path_id);


--
-- Name: analysis_run_provider_models analysis_run_provider_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_provider_models
    ADD CONSTRAINT analysis_run_provider_models_pkey PRIMARY KEY (analysis_run_provider_model_id);


--
-- Name: analysis_run_provider_models analysis_run_provider_models_run_ordinal_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_provider_models
    ADD CONSTRAINT analysis_run_provider_models_run_ordinal_unique UNIQUE (analysis_run_id, ordinal);


--
-- Name: analysis_run_provider_models analysis_run_provider_models_run_provider_model_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_provider_models
    ADD CONSTRAINT analysis_run_provider_models_run_provider_model_unique UNIQUE (analysis_run_id, provider, model);


--
-- Name: analysis_run_requested_categories analysis_run_requested_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_requested_categories
    ADD CONSTRAINT analysis_run_requested_categories_pkey PRIMARY KEY (analysis_run_requested_category_id);


--
-- Name: analysis_run_requested_categories analysis_run_requested_categories_run_category_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_requested_categories
    ADD CONSTRAINT analysis_run_requested_categories_run_category_unique UNIQUE (analysis_run_id, category_id);


--
-- Name: analysis_run_requested_categories analysis_run_requested_categories_run_ordinal_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_requested_categories
    ADD CONSTRAINT analysis_run_requested_categories_run_ordinal_unique UNIQUE (analysis_run_id, ordinal);


--
-- Name: analysis_runs analysis_runs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_runs
    ADD CONSTRAINT analysis_runs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: analysis_runs analysis_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_runs
    ADD CONSTRAINT analysis_runs_pkey PRIMARY KEY (analysis_run_id);


--
-- Name: anonymous_sessions anonymous_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anonymous_sessions
    ADD CONSTRAINT anonymous_sessions_pkey PRIMARY KEY (anonymous_session_id);


--
-- Name: anonymous_sessions anonymous_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anonymous_sessions
    ADD CONSTRAINT anonymous_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: brand_products brand_products_category_brand_product_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_products
    ADD CONSTRAINT brand_products_category_brand_product_unique UNIQUE (category_brand_id, product_id);


--
-- Name: brand_products brand_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_products
    ADD CONSTRAINT brand_products_pkey PRIMARY KEY (brand_product_id);


--
-- Name: brands brands_normalized_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brands
    ADD CONSTRAINT brands_normalized_name_key UNIQUE (normalized_name);


--
-- Name: brands brands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brands
    ADD CONSTRAINT brands_pkey PRIMARY KEY (brand_id);


--
-- Name: budget_policies budget_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_policies
    ADD CONSTRAINT budget_policies_pkey PRIMARY KEY (budget_policy_id);


--
-- Name: budget_policies budget_policies_scope_provider_model_window_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_policies
    ADD CONSTRAINT budget_policies_scope_provider_model_window_unique UNIQUE NULLS NOT DISTINCT (budget_scope, workspace_id, user_id, anonymous_session_id, analysis_run_id, provider, model, window_seconds);


--
-- Name: categories categories_normalized_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_normalized_name_key UNIQUE (normalized_name);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (category_id);


--
-- Name: category_brands category_brands_domain_category_brand_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_brands
    ADD CONSTRAINT category_brands_domain_category_brand_unique UNIQUE (domain_category_id, brand_id);


--
-- Name: category_brands category_brands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_brands
    ADD CONSTRAINT category_brands_pkey PRIMARY KEY (category_brand_id);


--
-- Name: domain_categories domain_categories_domain_category_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_categories
    ADD CONSTRAINT domain_categories_domain_category_unique UNIQUE (domain_id, category_id);


--
-- Name: domain_categories domain_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_categories
    ADD CONSTRAINT domain_categories_pkey PRIMARY KEY (domain_category_id);


--
-- Name: domain_category_classification_jobs domain_category_classification_jobs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_category_classification_jobs
    ADD CONSTRAINT domain_category_classification_jobs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: domain_category_classification_jobs domain_category_classification_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_category_classification_jobs
    ADD CONSTRAINT domain_category_classification_jobs_pkey PRIMARY KEY (domain_category_classification_job_id);


--
-- Name: domain_category_classification_jobs domain_category_classification_jobs_run_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_category_classification_jobs
    ADD CONSTRAINT domain_category_classification_jobs_run_hash_unique UNIQUE (analysis_run_id, candidate_set_hash);


--
-- Name: domains domains_normalized_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_normalized_domain_key UNIQUE (normalized_domain);


--
-- Name: domains domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_pkey PRIMARY KEY (domain_id);


--
-- Name: entity_paths entity_paths_hierarchy_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_paths
    ADD CONSTRAINT entity_paths_hierarchy_unique UNIQUE NULLS NOT DISTINCT (domain_id, category_id, brand_id, product_id, use_context_id);


--
-- Name: entity_paths entity_paths_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_paths
    ADD CONSTRAINT entity_paths_pkey PRIMARY KEY (entity_path_id);


--
-- Name: failure_records failure_records_message_attempt_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failure_records
    ADD CONSTRAINT failure_records_message_attempt_unique UNIQUE (queue_name, message_id, attempt_number);


--
-- Name: failure_records failure_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failure_records
    ADD CONSTRAINT failure_records_pkey PRIMARY KEY (failure_record_id);


--
-- Name: llm_runs llm_runs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_runs
    ADD CONSTRAINT llm_runs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: llm_runs llm_runs_item_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_runs
    ADD CONSTRAINT llm_runs_item_key_unique UNIQUE (analysis_run_item_id, run_key);


--
-- Name: llm_runs llm_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_runs
    ADD CONSTRAINT llm_runs_pkey PRIMARY KEY (llm_run_id);


--
-- Name: notifications notifications_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (notification_id);


--
-- Name: outbox_events outbox_events_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_event_key_key UNIQUE (event_key);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (outbox_event_id);


--
-- Name: product_use_contexts product_use_contexts_brand_product_context_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_use_contexts
    ADD CONSTRAINT product_use_contexts_brand_product_context_unique UNIQUE (brand_product_id, use_context_id);


--
-- Name: product_use_contexts product_use_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_use_contexts
    ADD CONSTRAINT product_use_contexts_pkey PRIMARY KEY (product_use_context_id);


--
-- Name: products products_normalized_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_normalized_name_key UNIQUE (normalized_name);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (product_id);


--
-- Name: prompt_jobs prompt_jobs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_jobs
    ADD CONSTRAINT prompt_jobs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: prompt_jobs prompt_jobs_llm_type_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_jobs
    ADD CONSTRAINT prompt_jobs_llm_type_version_unique UNIQUE (llm_run_id, prompt_type, business_prompt_version, prompt_depth);


--
-- Name: prompt_jobs prompt_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_jobs
    ADD CONSTRAINT prompt_jobs_pkey PRIMARY KEY (prompt_job_id);


--
-- Name: provider_jobs provider_jobs_id_provider_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_jobs
    ADD CONSTRAINT provider_jobs_id_provider_unique UNIQUE (provider_job_id, provider);


--
-- Name: provider_jobs provider_jobs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_jobs
    ADD CONSTRAINT provider_jobs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: provider_jobs provider_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_jobs
    ADD CONSTRAINT provider_jobs_pkey PRIMARY KEY (provider_job_id);


--
-- Name: provider_jobs provider_jobs_prompt_provider_model_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

--
-- Name: provider_results provider_results_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_results
    ADD CONSTRAINT provider_results_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: provider_results provider_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_results
    ADD CONSTRAINT provider_results_pkey PRIMARY KEY (provider_result_id);


--
-- Name: provider_results provider_results_provider_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_results
    ADD CONSTRAINT provider_results_provider_job_id_key UNIQUE (provider_job_id);


--
-- Name: provider_scores provider_scores_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_scores
    ADD CONSTRAINT provider_scores_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: provider_scores provider_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_scores
    ADD CONSTRAINT provider_scores_pkey PRIMARY KEY (provider_score_id);


--
-- Name: provider_scores provider_scores_result_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_scores
    ADD CONSTRAINT provider_scores_result_version_unique UNIQUE (provider_result_id, scoring_version, metric_type);


--
-- Name: reports reports_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (report_id);


--
-- Name: reports reports_run_version_revision_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_run_version_revision_unique UNIQUE (analysis_run_id, report_version, revision);


--
-- Name: scheduler_jobs scheduler_jobs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_jobs
    ADD CONSTRAINT scheduler_jobs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: scheduler_jobs scheduler_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_jobs
    ADD CONSTRAINT scheduler_jobs_pkey PRIMARY KEY (scheduler_job_id);


--
-- Name: scheduler_jobs scheduler_jobs_workspace_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_jobs
    ADD CONSTRAINT scheduler_jobs_workspace_name_unique UNIQUE (workspace_id, job_name);


--
-- Name: scheduler_job_requested_categories scheduler_job_requested_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_job_requested_categories
    ADD CONSTRAINT scheduler_job_requested_categories_pkey PRIMARY KEY (scheduler_job_requested_category_id);


--
-- Name: scheduler_job_requested_categories scheduler_job_requested_categories_job_category_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_job_requested_categories
    ADD CONSTRAINT scheduler_job_requested_categories_job_category_unique UNIQUE (scheduler_job_id, category_id);


--
-- Name: scheduler_job_requested_categories scheduler_job_requested_categories_job_ordinal_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_job_requested_categories
    ADD CONSTRAINT scheduler_job_requested_categories_job_ordinal_unique UNIQUE (scheduler_job_id, ordinal);


--
-- Name: token_usage token_usage_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_usage
    ADD CONSTRAINT token_usage_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: token_usage token_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_usage
    ADD CONSTRAINT token_usage_pkey PRIMARY KEY (token_usage_id);


--
-- Name: token_usage token_usage_provider_kind_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_usage
    ADD CONSTRAINT token_usage_provider_kind_unique UNIQUE (provider_job_id, usage_kind);


--
-- Name: use_contexts use_contexts_normalized_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.use_contexts
    ADD CONSTRAINT use_contexts_normalized_name_key UNIQUE (normalized_name);


--
-- Name: use_contexts use_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.use_contexts
    ADD CONSTRAINT use_contexts_pkey PRIMARY KEY (use_context_id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (user_session_id);


--
-- Name: user_sessions user_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: workspace_role_change_requests workspace_role_change_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_role_change_requests
    ADD CONSTRAINT workspace_role_change_requests_pkey PRIMARY KEY (workspace_role_change_request_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (workspace_id);


--
-- Name: analysis_run_items_run_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_run_items_run_status_idx ON public.analysis_run_items USING btree (analysis_run_id, status, item_ordinal);


--
-- Name: analysis_run_items_status_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_run_items_status_updated_idx ON public.analysis_run_items USING btree (status, updated_at);


--
-- Name: analysis_run_provider_models_run_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_run_provider_models_run_order_idx ON public.analysis_run_provider_models USING btree (analysis_run_id, ordinal);


CREATE INDEX analysis_run_requested_categories_run_order_idx ON public.analysis_run_requested_categories USING btree (analysis_run_id, ordinal);


--
-- Name: analysis_runs_anonymous_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_runs_anonymous_history_idx ON public.analysis_runs USING btree (anonymous_session_id, created_at DESC) WHERE (anonymous_session_id IS NOT NULL);


--
-- Name: analysis_runs_status_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_runs_status_updated_idx ON public.analysis_runs USING btree (status, updated_at);


--
-- Name: analysis_runs_user_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_runs_user_history_idx ON public.analysis_runs USING btree (user_id, created_at DESC) WHERE (user_id IS NOT NULL);


--
-- Name: analysis_runs_workspace_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_runs_workspace_history_idx ON public.analysis_runs USING btree (workspace_id, created_at DESC) WHERE (workspace_id IS NOT NULL);


--
-- Name: anonymous_sessions_active_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX anonymous_sessions_active_expiry_idx ON public.anonymous_sessions USING btree (expires_at) WHERE (status = 'active'::public.session_status);


--
-- Name: anonymous_sessions_claimed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX anonymous_sessions_claimed_idx ON public.anonymous_sessions USING btree (claimed_workspace_id, claimed_by_user_id) WHERE (claimed_workspace_id IS NOT NULL);


--
-- Name: brand_products_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brand_products_product_idx ON public.brand_products USING btree (product_id);


--
-- Name: brand_products_selection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brand_products_selection_idx ON public.brand_products USING btree (category_brand_id, is_active, sort_order, created_at, brand_product_id);


--
-- Name: budget_policies_anonymous_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_policies_anonymous_lookup_idx ON public.budget_policies USING btree (anonymous_session_id, provider, model) WHERE (is_enabled AND (anonymous_session_id IS NOT NULL));


--
-- Name: budget_policies_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_policies_lookup_idx ON public.budget_policies USING btree (budget_scope, workspace_id, provider) WHERE is_enabled;


--
-- Name: budget_policies_run_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_policies_run_lookup_idx ON public.budget_policies USING btree (analysis_run_id, provider, model) WHERE (is_enabled AND (analysis_run_id IS NOT NULL));


--
-- Name: budget_policies_user_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_policies_user_lookup_idx ON public.budget_policies USING btree (user_id, provider, model) WHERE (is_enabled AND (user_id IS NOT NULL));


--
-- Name: category_brands_brand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX category_brands_brand_idx ON public.category_brands USING btree (brand_id);


--
-- Name: category_brands_selection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX category_brands_selection_idx ON public.category_brands USING btree (domain_category_id, is_active, sort_order, created_at, category_brand_id);


--
-- Name: domain_categories_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domain_categories_category_idx ON public.domain_categories USING btree (category_id);


--
-- Name: domain_categories_selection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domain_categories_selection_idx ON public.domain_categories USING btree (domain_id, is_active, sort_order, created_at, domain_category_id);


CREATE INDEX domain_category_classification_jobs_dispatch_idx ON public.domain_category_classification_jobs USING btree (status, created_at, domain_category_classification_job_id) WHERE (status = ANY (ARRAY['queued'::public.classification_job_status, 'processing'::public.classification_job_status]));


CREATE INDEX domain_category_classification_jobs_run_idx ON public.domain_category_classification_jobs USING btree (analysis_run_id, created_at);


--
-- Name: entity_paths_domain_category_brand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_paths_domain_category_brand_idx ON public.entity_paths USING btree (domain_id, category_id, brand_id) WHERE (brand_id IS NOT NULL);


--
-- Name: entity_paths_domain_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_paths_domain_category_idx ON public.entity_paths USING btree (domain_id, category_id) WHERE (category_id IS NOT NULL);


--
-- Name: entity_paths_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_paths_domain_idx ON public.entity_paths USING btree (domain_id, entity_path_id);


--
-- Name: entity_paths_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_paths_product_idx ON public.entity_paths USING btree (product_id, use_context_id) WHERE (product_id IS NOT NULL);


--
-- Name: failure_records_open_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX failure_records_open_queue_idx ON public.failure_records USING btree (queue_name, occurred_at DESC) WHERE (status = ANY (ARRAY['open'::public.failure_record_status, 'acknowledged'::public.failure_record_status]));


CREATE INDEX failure_records_aggregate_status_idx ON public.failure_records USING btree (aggregate_type, aggregate_id, status, occurred_at DESC) WHERE (aggregate_type IS NOT NULL AND aggregate_id IS NOT NULL);

CREATE INDEX failure_records_report_finality_idx ON public.failure_records USING btree (aggregate_type, aggregate_id, queue_name, attempt_number DESC) WHERE (aggregate_type IS NOT NULL AND aggregate_id IS NOT NULL);


--
-- Name: llm_runs_item_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_runs_item_status_idx ON public.llm_runs USING btree (analysis_run_item_id, status);


--
-- Name: llm_runs_status_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_runs_status_updated_idx ON public.llm_runs USING btree (status, updated_at);


--
-- Name: notifications_analysis_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_analysis_run_idx ON public.notifications USING btree (analysis_run_id, created_at DESC) WHERE (analysis_run_id IS NOT NULL);


--
-- Name: notifications_delivery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_delivery_idx ON public.notifications USING btree (status, available_at, notification_id) WHERE (status = ANY (ARRAY['pending'::public.notification_status, 'queued'::public.notification_status, 'failed'::public.notification_status]));


--
-- Name: outbox_events_aggregate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_events_aggregate_idx ON public.outbox_events USING btree (aggregate_type, aggregate_id, created_at);


--
-- Name: outbox_events_publishable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_events_publishable_idx ON public.outbox_events USING btree (status, available_at, outbox_event_id) WHERE (status = ANY (ARRAY['pending'::public.outbox_status, 'failed'::public.outbox_status]));


--
-- Name: outbox_events_published_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_events_published_idx ON public.outbox_events USING btree (published_at) WHERE (status = 'published'::public.outbox_status);


--
-- Name: outbox_events_stale_publishing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_events_stale_publishing_idx ON public.outbox_events USING btree (locked_at, outbox_event_id) WHERE (status = 'publishing'::public.outbox_status);


--
-- Name: product_use_contexts_selection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_use_contexts_selection_idx ON public.product_use_contexts USING btree (brand_product_id, is_active, sort_order, created_at, product_use_context_id);


--
-- Name: product_use_contexts_use_context_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_use_contexts_use_context_idx ON public.product_use_contexts USING btree (use_context_id);


--
-- Name: prompt_jobs_dispatch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_jobs_dispatch_idx ON public.prompt_jobs USING btree (status, available_at, priority DESC, prompt_job_id) WHERE (status = ANY (ARRAY['pending'::public.job_status, 'queued'::public.job_status, 'failed'::public.job_status]));


--
-- Name: prompt_jobs_llm_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_jobs_llm_run_idx ON public.prompt_jobs USING btree (llm_run_id, prompt_type);


--
-- Name: provider_jobs_dispatch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_jobs_dispatch_idx ON public.provider_jobs USING btree (provider, status, available_at, provider_job_id) WHERE (status = ANY (ARRAY['pending'::public.job_status, 'queued'::public.job_status, 'failed'::public.job_status]));


--
-- Name: provider_jobs_prompt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_jobs_prompt_idx ON public.provider_jobs USING btree (prompt_job_id, provider);


CREATE INDEX provider_jobs_classification_idx ON public.provider_jobs USING btree (classification_job_id, provider) WHERE (classification_job_id IS NOT NULL);


CREATE UNIQUE INDEX provider_jobs_normal_prompt_unique_idx ON public.provider_jobs USING btree (prompt_job_id, provider, model) WHERE (job_kind = 'normal_prompt'::public.provider_job_kind);


CREATE UNIQUE INDEX provider_jobs_classification_unique_idx ON public.provider_jobs USING btree (classification_job_id) WHERE (job_kind = 'domain_category_classification'::public.provider_job_kind);


--
-- Name: provider_results_provider_request_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_results_provider_request_unique_idx ON public.provider_results USING btree (provider, provider_request_id) WHERE (provider_request_id IS NOT NULL);


--
-- Name: provider_scores_result_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_scores_result_idx ON public.provider_scores USING btree (provider_result_id, calculated_at DESC);


--
-- Name: reports_latest_revision_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_latest_revision_idx ON public.reports USING btree (analysis_run_id, report_version, revision DESC);


--
-- Name: reports_run_generated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_run_generated_idx ON public.reports USING btree (analysis_run_id, generated_at DESC);


--
-- Name: scheduler_jobs_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduler_jobs_due_idx ON public.scheduler_jobs USING btree (next_run_at, scheduler_job_id) WHERE (status = 'active'::public.scheduler_job_status);


--
-- Name: scheduler_jobs_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduler_jobs_workspace_idx ON public.scheduler_jobs USING btree (workspace_id, status);


CREATE INDEX scheduler_job_requested_categories_job_order_idx ON public.scheduler_job_requested_categories USING btree (scheduler_job_id, ordinal);


--
-- Name: token_usage_provider_recorded_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX token_usage_provider_recorded_idx ON public.token_usage USING btree (provider_job_id, recorded_at DESC);


--
-- Name: user_sessions_active_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_sessions_active_expiry_idx ON public.user_sessions USING btree (expires_at) WHERE (status = 'active'::public.session_status);


--
-- Name: user_sessions_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_sessions_user_status_idx ON public.user_sessions USING btree (user_id, status);


--
-- Name: users_email_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_unique_idx ON public.users USING btree (lower(email));


--
-- Name: workspace_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_members_user_idx ON public.workspace_members USING btree (user_id, workspace_id);


--
-- Name: workspace_role_change_one_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_role_change_one_pending_idx ON public.workspace_role_change_requests USING btree (workspace_id, target_user_id) WHERE (status = 'pending'::public.workspace_role_change_status);


--
-- Name: workspace_role_change_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_role_change_pending_idx ON public.workspace_role_change_requests USING btree (workspace_id, created_at) WHERE (status = 'pending'::public.workspace_role_change_status);


--
-- Name: analysis_run_provider_models analysis_run_provider_models_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_run_provider_models_immutable_trigger BEFORE DELETE OR UPDATE ON public.analysis_run_provider_models FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_evidence_mutation();


CREATE TRIGGER analysis_run_requested_categories_immutable_trigger BEFORE DELETE OR UPDATE ON public.analysis_run_requested_categories FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_evidence_mutation();


CREATE TRIGGER domain_category_classification_jobs_identity_trigger BEFORE UPDATE ON public.domain_category_classification_jobs FOR EACH ROW EXECUTE FUNCTION public.preserve_classification_job_execution_identity();


--
-- Name: analysis_runs analysis_runs_notify_budget_paused_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_runs_notify_budget_paused_trigger AFTER UPDATE OF status ON public.analysis_runs FOR EACH ROW EXECUTE FUNCTION public.notify_budget_paused();


--
-- Name: analysis_runs analysis_runs_notify_cancelled_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_runs_notify_cancelled_trigger AFTER UPDATE OF status ON public.analysis_runs FOR EACH ROW EXECUTE FUNCTION public.notify_analysis_cancelled();


--
-- Name: analysis_runs analysis_runs_preserve_anonymous_origin_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_runs_preserve_anonymous_origin_trigger BEFORE UPDATE OF anonymous_session_id ON public.analysis_runs FOR EACH ROW EXECUTE FUNCTION public.preserve_analysis_run_anonymous_origin();


--
-- Name: analysis_runs analysis_runs_validate_anonymous_claim_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_runs_validate_anonymous_claim_trigger BEFORE INSERT OR UPDATE OF anonymous_session_id, user_id, workspace_id ON public.analysis_runs FOR EACH ROW EXECUTE FUNCTION public.validate_analysis_run_anonymous_claim();


--
-- Name: anonymous_sessions anonymous_sessions_preserve_claim_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER anonymous_sessions_preserve_claim_trigger BEFORE UPDATE OF claimed_by_user_id, claimed_workspace_id, claimed_at ON public.anonymous_sessions FOR EACH ROW EXECUTE FUNCTION public.preserve_anonymous_session_claim();


--
-- Name: failure_records failure_records_notify_terminal_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER failure_records_notify_terminal_trigger AFTER INSERT ON public.failure_records FOR EACH ROW EXECUTE FUNCTION public.notify_terminal_failure();


--
-- Name: provider_jobs provider_jobs_require_rendered_prompt_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER provider_jobs_require_rendered_prompt_trigger BEFORE INSERT OR UPDATE OF job_kind, prompt_job_id, classification_job_id ON public.provider_jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_provider_job_rendered_prompt();


CREATE TRIGGER provider_jobs_preserve_execution_identity_trigger BEFORE UPDATE ON public.provider_jobs FOR EACH ROW EXECUTE FUNCTION public.preserve_provider_job_execution_identity();




--
-- Name: provider_results provider_results_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER provider_results_immutable_trigger BEFORE DELETE OR UPDATE ON public.provider_results FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_evidence_mutation();


--
-- Name: provider_scores provider_scores_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER provider_scores_immutable_trigger BEFORE DELETE OR UPDATE ON public.provider_scores FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_evidence_mutation();


--
-- Name: reports reports_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reports_immutable_trigger BEFORE DELETE OR UPDATE ON public.reports FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_evidence_mutation();


--
-- Name: reports reports_notify_ready_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reports_notify_ready_trigger AFTER INSERT ON public.reports FOR EACH ROW EXECUTE FUNCTION public.notify_report_ready();


CREATE TRIGGER scheduler_job_requested_categories_immutable_trigger BEFORE DELETE OR UPDATE ON public.scheduler_job_requested_categories FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_evidence_mutation();


--
-- Name: token_usage token_usage_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER token_usage_immutable_trigger BEFORE DELETE OR UPDATE ON public.token_usage FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_evidence_mutation();


--
-- Name: analysis_run_items analysis_run_items_analysis_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_items
    ADD CONSTRAINT analysis_run_items_analysis_run_id_fkey FOREIGN KEY (analysis_run_id) REFERENCES public.analysis_runs(analysis_run_id) ON DELETE RESTRICT;


--
-- Name: analysis_run_items analysis_run_items_entity_path_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_items
    ADD CONSTRAINT analysis_run_items_entity_path_id_fkey FOREIGN KEY (entity_path_id) REFERENCES public.entity_paths(entity_path_id) ON DELETE RESTRICT;


--
-- Name: analysis_run_provider_models analysis_run_provider_models_analysis_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run_provider_models
    ADD CONSTRAINT analysis_run_provider_models_analysis_run_id_fkey FOREIGN KEY (analysis_run_id) REFERENCES public.analysis_runs(analysis_run_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.analysis_run_requested_categories
    ADD CONSTRAINT analysis_run_requested_categories_analysis_run_id_fkey FOREIGN KEY (analysis_run_id) REFERENCES public.analysis_runs(analysis_run_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.analysis_run_requested_categories
    ADD CONSTRAINT analysis_run_requested_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(category_id) ON DELETE RESTRICT;


--
-- Name: analysis_runs analysis_runs_anonymous_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_runs
    ADD CONSTRAINT analysis_runs_anonymous_session_id_fkey FOREIGN KEY (anonymous_session_id) REFERENCES public.anonymous_sessions(anonymous_session_id) ON DELETE RESTRICT;


--
-- Name: analysis_runs analysis_runs_starting_entity_path_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_runs
    ADD CONSTRAINT analysis_runs_starting_entity_path_id_fkey FOREIGN KEY (starting_entity_path_id) REFERENCES public.entity_paths(entity_path_id) ON DELETE RESTRICT;


--
-- Name: analysis_runs analysis_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_runs
    ADD CONSTRAINT analysis_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE RESTRICT;


--
-- Name: analysis_runs analysis_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_runs
    ADD CONSTRAINT analysis_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE RESTRICT;


--
-- Name: analysis_runs analysis_runs_workspace_membership_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_runs
    ADD CONSTRAINT analysis_runs_workspace_membership_fk FOREIGN KEY (workspace_id, user_id) REFERENCES public.workspace_members(workspace_id, user_id) MATCH FULL ON DELETE RESTRICT;


--
-- Name: anonymous_sessions anonymous_sessions_claimed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anonymous_sessions
    ADD CONSTRAINT anonymous_sessions_claimed_by_user_id_fkey FOREIGN KEY (claimed_by_user_id) REFERENCES public.users(user_id) ON DELETE RESTRICT;


--
-- Name: anonymous_sessions anonymous_sessions_claimed_membership_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anonymous_sessions
    ADD CONSTRAINT anonymous_sessions_claimed_membership_fk FOREIGN KEY (claimed_workspace_id, claimed_by_user_id) REFERENCES public.workspace_members(workspace_id, user_id) MATCH FULL ON DELETE RESTRICT;


--
-- Name: anonymous_sessions anonymous_sessions_claimed_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anonymous_sessions
    ADD CONSTRAINT anonymous_sessions_claimed_workspace_fk FOREIGN KEY (claimed_workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE RESTRICT;


--
-- Name: brand_products brand_products_category_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_products
    ADD CONSTRAINT brand_products_category_brand_id_fkey FOREIGN KEY (category_brand_id) REFERENCES public.category_brands(category_brand_id) ON DELETE RESTRICT;


--
-- Name: brand_products brand_products_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_products
    ADD CONSTRAINT brand_products_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(product_id) ON DELETE RESTRICT;


--
-- Name: budget_policies budget_policies_analysis_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_policies
    ADD CONSTRAINT budget_policies_analysis_run_id_fkey FOREIGN KEY (analysis_run_id) REFERENCES public.analysis_runs(analysis_run_id) ON DELETE RESTRICT;


--
-- Name: budget_policies budget_policies_anonymous_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_policies
    ADD CONSTRAINT budget_policies_anonymous_session_id_fkey FOREIGN KEY (anonymous_session_id) REFERENCES public.anonymous_sessions(anonymous_session_id) ON DELETE RESTRICT;


--
-- Name: budget_policies budget_policies_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_policies
    ADD CONSTRAINT budget_policies_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE RESTRICT;


--
-- Name: budget_policies budget_policies_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_policies
    ADD CONSTRAINT budget_policies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE RESTRICT;


--
-- Name: category_brands category_brands_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_brands
    ADD CONSTRAINT category_brands_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(brand_id) ON DELETE RESTRICT;


--
-- Name: category_brands category_brands_domain_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_brands
    ADD CONSTRAINT category_brands_domain_category_id_fkey FOREIGN KEY (domain_category_id) REFERENCES public.domain_categories(domain_category_id) ON DELETE RESTRICT;


--
-- Name: domain_categories domain_categories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_categories
    ADD CONSTRAINT domain_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(category_id) ON DELETE RESTRICT;


--
-- Name: domain_categories domain_categories_domain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_categories
    ADD CONSTRAINT domain_categories_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(domain_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.domain_categories
    ADD CONSTRAINT domain_categories_classification_provider_result_id_fkey FOREIGN KEY (classification_provider_result_id) REFERENCES public.provider_results(provider_result_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.domain_category_classification_jobs
    ADD CONSTRAINT domain_category_classification_jobs_analysis_run_id_fkey FOREIGN KEY (analysis_run_id) REFERENCES public.analysis_runs(analysis_run_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.domain_category_classification_jobs
    ADD CONSTRAINT domain_category_classification_jobs_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(domain_id) ON DELETE RESTRICT;


--
-- Name: entity_paths entity_paths_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_paths
    ADD CONSTRAINT entity_paths_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(brand_id) ON DELETE RESTRICT;


--
-- Name: entity_paths entity_paths_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_paths
    ADD CONSTRAINT entity_paths_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(category_id) ON DELETE RESTRICT;


--
-- Name: entity_paths entity_paths_domain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_paths
    ADD CONSTRAINT entity_paths_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(domain_id) ON DELETE RESTRICT;


--
-- Name: entity_paths entity_paths_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_paths
    ADD CONSTRAINT entity_paths_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(product_id) ON DELETE RESTRICT;


--
-- Name: entity_paths entity_paths_use_context_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_paths
    ADD CONSTRAINT entity_paths_use_context_id_fkey FOREIGN KEY (use_context_id) REFERENCES public.use_contexts(use_context_id) ON DELETE RESTRICT;


--
-- Name: llm_runs llm_runs_analysis_run_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_runs
    ADD CONSTRAINT llm_runs_analysis_run_item_id_fkey FOREIGN KEY (analysis_run_item_id) REFERENCES public.analysis_run_items(analysis_run_item_id) ON DELETE RESTRICT;


--
-- Name: notifications notifications_analysis_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_analysis_run_id_fkey FOREIGN KEY (analysis_run_id) REFERENCES public.analysis_runs(analysis_run_id) ON DELETE RESTRICT;


--
-- Name: notifications notifications_failure_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_failure_record_id_fkey FOREIGN KEY (failure_record_id) REFERENCES public.failure_records(failure_record_id) ON DELETE RESTRICT;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE RESTRICT;


--
-- Name: notifications notifications_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE RESTRICT;


--
-- Name: product_use_contexts product_use_contexts_brand_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_use_contexts
    ADD CONSTRAINT product_use_contexts_brand_product_id_fkey FOREIGN KEY (brand_product_id) REFERENCES public.brand_products(brand_product_id) ON DELETE RESTRICT;


--
-- Name: product_use_contexts product_use_contexts_use_context_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_use_contexts
    ADD CONSTRAINT product_use_contexts_use_context_id_fkey FOREIGN KEY (use_context_id) REFERENCES public.use_contexts(use_context_id) ON DELETE RESTRICT;


--
-- Name: prompt_jobs prompt_jobs_llm_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_jobs
    ADD CONSTRAINT prompt_jobs_llm_run_id_fkey FOREIGN KEY (llm_run_id) REFERENCES public.llm_runs(llm_run_id) ON DELETE RESTRICT;


--
-- Name: provider_jobs provider_jobs_prompt_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_jobs
    ADD CONSTRAINT provider_jobs_prompt_job_id_fkey FOREIGN KEY (prompt_job_id) REFERENCES public.prompt_jobs(prompt_job_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.provider_jobs
    ADD CONSTRAINT provider_jobs_classification_job_id_fkey FOREIGN KEY (classification_job_id) REFERENCES public.domain_category_classification_jobs(domain_category_classification_job_id) ON DELETE RESTRICT;


--
-- Name: provider_results provider_results_job_provider_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_results
    ADD CONSTRAINT provider_results_job_provider_fk FOREIGN KEY (provider_job_id, provider) REFERENCES public.provider_jobs(provider_job_id, provider) ON DELETE RESTRICT;


--
-- Name: provider_scores provider_scores_provider_result_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_scores
    ADD CONSTRAINT provider_scores_provider_result_id_fkey FOREIGN KEY (provider_result_id) REFERENCES public.provider_results(provider_result_id) ON DELETE RESTRICT;


--
-- Name: reports reports_analysis_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_analysis_run_id_fkey FOREIGN KEY (analysis_run_id) REFERENCES public.analysis_runs(analysis_run_id) ON DELETE RESTRICT;


--
-- Name: scheduler_jobs scheduler_jobs_last_analysis_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_jobs
    ADD CONSTRAINT scheduler_jobs_last_analysis_run_id_fkey FOREIGN KEY (last_analysis_run_id) REFERENCES public.analysis_runs(analysis_run_id) ON DELETE RESTRICT;


--
-- Name: scheduler_jobs scheduler_jobs_starting_entity_path_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_jobs
    ADD CONSTRAINT scheduler_jobs_starting_entity_path_id_fkey FOREIGN KEY (starting_entity_path_id) REFERENCES public.entity_paths(entity_path_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.scheduler_job_requested_categories
    ADD CONSTRAINT scheduler_job_requested_categories_scheduler_job_id_fkey FOREIGN KEY (scheduler_job_id) REFERENCES public.scheduler_jobs(scheduler_job_id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.scheduler_job_requested_categories
    ADD CONSTRAINT scheduler_job_requested_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(category_id) ON DELETE RESTRICT;


--
-- Name: scheduler_jobs scheduler_jobs_workspace_member_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_jobs
    ADD CONSTRAINT scheduler_jobs_workspace_member_fk FOREIGN KEY (workspace_id, created_by_user_id) REFERENCES public.workspace_members(workspace_id, user_id) ON DELETE RESTRICT;


--
-- Name: token_usage token_usage_provider_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_usage
    ADD CONSTRAINT token_usage_provider_job_id_fkey FOREIGN KEY (provider_job_id) REFERENCES public.provider_jobs(provider_job_id) ON DELETE RESTRICT;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE RESTRICT;


--
-- Name: workspace_members workspace_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE RESTRICT;


--
-- Name: workspace_members workspace_members_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE RESTRICT;


--
-- Name: workspace_role_change_requests workspace_role_change_requester_member_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_role_change_requests
    ADD CONSTRAINT workspace_role_change_requester_member_fk FOREIGN KEY (workspace_id, requested_by_user_id) REFERENCES public.workspace_members(workspace_id, user_id) ON DELETE RESTRICT;


--
-- Name: workspace_role_change_requests workspace_role_change_reviewer_member_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_role_change_requests
    ADD CONSTRAINT workspace_role_change_reviewer_member_fk FOREIGN KEY (workspace_id, reviewed_by_user_id) REFERENCES public.workspace_members(workspace_id, user_id) ON DELETE RESTRICT;


--
-- Name: workspace_role_change_requests workspace_role_change_target_member_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_role_change_requests
    ADD CONSTRAINT workspace_role_change_target_member_fk FOREIGN KEY (workspace_id, target_user_id) REFERENCES public.workspace_members(workspace_id, user_id) ON DELETE RESTRICT;


--
-- Name: workspaces workspaces_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(user_id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--
