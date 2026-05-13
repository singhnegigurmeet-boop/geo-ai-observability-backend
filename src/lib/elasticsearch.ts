import { Client } from "@elastic/elasticsearch";
import { env } from "../config/env.js";

export const elasticsearch = new Client({
  node: env.ELASTICSEARCH_NODE
});
