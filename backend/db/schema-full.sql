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
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id bigint NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    reward_type text DEFAULT 'monetary'::text NOT NULL,
    mechanics jsonb DEFAULT '{}'::jsonb NOT NULL,
    terms jsonb DEFAULT '{}'::jsonb NOT NULL,
    rules jsonb DEFAULT '{}'::jsonb NOT NULL,
    fee_split_bps integer DEFAULT 5000 NOT NULL,
    company_a text DEFAULT '0x0000000000000000000000000000000000000000'::text NOT NULL,
    company_b text DEFAULT '0x0000000000000000000000000000000000000000'::text NOT NULL,
    company_a_name text DEFAULT ''::text NOT NULL,
    company_b_name text DEFAULT ''::text NOT NULL,
    operating_deposit bigint DEFAULT '10000000000000000'::bigint NOT NULL,
    salt text,
    escrow_address text,
    reward_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    launched_at timestamp with time zone,
    deposit_deadline timestamp with time zone,
    deposits jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT campaigns_fee_split_bps_check CHECK (((fee_split_bps >= 0) AND (fee_split_bps <= 10000))),
    CONSTRAINT campaigns_reward_type_check CHECK ((reward_type = ANY (ARRAY['monetary'::text, 'digital'::text, 'physical'::text]))),
    CONSTRAINT campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_deposit'::text, 'launched'::text, 'cancelled'::text])))
);


--
-- Name: campaigns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.campaigns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: campaigns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.campaigns_id_seq OWNED BY public.campaigns.id;


--
-- Name: campaigns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns ALTER COLUMN id SET DEFAULT nextval('public.campaigns_id_seq'::regclass);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: idx_campaigns_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaigns_status ON public.campaigns USING btree (status);


--
-- PostgreSQL database dump complete
--
