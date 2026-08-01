import { env } from "../../../common/config/env.js";
import { pool } from "../../../common/database/postgres.js";
import { RabbitMqConnection } from "../../../common/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../../../common/messaging/rabbitmq.topology.js";
import { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import { HierarchyDiscoveryWorkerRuntime } from "../runtime/hierarchy-discovery-worker.runtime.js";
import { HierarchyDiscoveryService } from "../services/hierarchy-discovery.service.js";
import { HierarchyDiscoveryWorker } from "../workers/hierarchy-discovery.worker.js";

const rabbitMq=new RabbitMqConnection({url:env.RABBITMQ_URL,initializeChannel:(channel)=>declareRabbitMqTopology(channel,{mainExchange:env.RABBITMQ_EXCHANGE,deadLetterExchange:env.RABBITMQ_DEAD_LETTER_EXCHANGE})});
let runtime:HierarchyDiscoveryWorkerRuntime|null=null;
async function main(){const channel=await rabbitMq.getConfirmChannel();runtime=new HierarchyDiscoveryWorkerRuntime(channel,new HierarchyDiscoveryWorker(new HierarchyDiscoveryService(pool,env.ENABLE_REAL_PROVIDERS)),new FailureRecordRepository(pool),{mainExchange:env.RABBITMQ_EXCHANGE,prefetch:env.DISCOVERY_WORKER_PREFETCH});await runtime.start();process.once("SIGINT",()=>void shutdown());process.once("SIGTERM",()=>void shutdown());}
async function shutdown(){await runtime?.stop();await rabbitMq.close();await pool.end();}
main().catch(async(error)=>{console.error("Hierarchy discovery worker failed.",error);process.exitCode=1;await rabbitMq.close();await pool.end();});
