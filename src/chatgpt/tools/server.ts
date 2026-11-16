import { CLOUD_AUDIENCE } from "../auth/configuration.js";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { requireRecordAuthority, type CloudRecordAuthority } from "../records/authority.js";
import { createCloudRecordRepository } from "../records/repository.js";
import { RecordError, type RecordErrorCode } from "../records/types.js";
import { createCloudDocumentRepository } from "../documents/repository.js";
import { createDocumentPreviewService } from "../documents/preview.js";
import { createPricingGuidanceService } from "../pricing/guidance.js";

const str=z.string(), nullable=str.nullable(), rev=z.number().int().positive(), unit=z.enum(["each","hour","day","sq_ft","linear_ft","cu_yd","lb","gal","job"]).nullable(), kind=z.enum(["service","labor","materials","fee","other"]);
const site=z.strictObject({id:str,recipientName:nullable.optional(),addressKind:z.enum(["jobSite","shipTo"]),displayAddress:str});
const customer=z.strictObject({name:str,email:nullable.optional(),phone:nullable.optional(),billingAddressLines:z.array(str).max(10),savedJobSites:z.array(site).max(20)});
const provenance=z.strictObject({kind:z.enum(["explicit","saved_rate","history","guidance","estimate","unspecified"]),reference:nullable,asOf:z.number().int().positive().nullable()});
const line=z.strictObject({id:str.optional(),title:str,detail:nullable,quantity:str,unitPrice:str,unit,kind,reportedProvenance:provenance.optional()});
const input=z.strictObject({documentType:z.enum(["invoice","estimate"]),issueDate:str,serviceDate:nullable,dueDate:nullable,title:str,notes:nullable,paymentTermsSummary:nullable,jobSiteId:nullable,lines:z.array(line).min(1).max(200),discountAmount:str});
const patch=z.strictObject({title:str.optional(),issueDate:str.optional(),serviceDate:nullable.optional(),dueDate:nullable.optional(),notes:nullable.optional(),paymentTermsSummary:nullable.optional(),jobSiteId:nullable.optional(),lines:z.array(line).min(1).max(200).optional(),discountAmount:str.optional(),customerSelection:z.strictObject({id:str,expectedRevision:rev}).optional()});
const search=z.strictObject({query:str,limit:z.number().int().min(1).max(100),afterId:str.optional()});
const id=z.strictObject({id:str});
const preview=z.strictObject({businessRevision:rev,customerId:str,customerRevision:rev,input});
const errorCodes: readonly RecordErrorCode[]=["invalid_input","not_authorized","not_ready","entitlement_required","revision_conflict","operation_conflict","not_found","resync_required","storage_unavailable","invalid_configuration","number_collision","numbering_exhausted"];
const descriptions: Record<string,string> = {
  get_business_context:"Read the current business profile and its local date.",
  search_customers:"Search owned customers using a bounded page.",
  get_customer:"Read an owned customer by ID.",
  create_customer:"Persist a new customer using an operation key.",
  search_saved_rates:"Search owned saved rates using a bounded page.",
  get_pricing_guidance:"Get advisory pricing options from limited owned data; market guidance is unavailable.",
  preview_document:"Calculate an unsaved draft preview without allocating a number.",
  create_document:"Persist a numbered draft requiring native review.",
  get_document:"Read an owned document by ID.",
  update_document:"Persist changes to a draft requiring native review.",
  convert_estimate_to_invoice:"Persist an invoice draft from an estimate requiring native review.",
  open_in_app:"Return a link for native review; this does not launch the app.",
};
const resource = new URL(CLOUD_AUDIENCE);
const challenge = `Bearer resource_metadata="${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}", scope="cloud:access"`;
const failure=(code:RecordErrorCode)=>({...(code === "not_authorized" ? {_meta:{"mcp/www_authenticate":[challenge]}} : {}),isError:true,content:[{type:"text" as const,text:`Error: ${code}`}],structuredContent:{ok:false,error:{code}}});
export function createCloudToolServer(db:D1Database, dependencies:{authorizationNamespace:string;now?:()=>number}, authority:CloudRecordAuthority) {
  requireRecordAuthority(authority,dependencies.authorizationNamespace);
  const records=createCloudRecordRepository(db,dependencies), docs=createCloudDocumentRepository(db,dependencies), previews=createDocumentPreviewService(db,dependencies), pricing=createPricingGuidanceService(db,dependencies);
  const server=new McpServer({name:"simplitica-cloud-tools",version:"1.0.0"});
  const registry=new Map<string,{schema:z.ZodType; run:(args:never)=>Promise<unknown>}>();
  function add<S extends z.ZodType>(name:string, schema:S, readOnly:boolean, run:(args:z.output<S>)=>Promise<unknown>) {
    const execute=run as (args:never)=>Promise<unknown>;
    registry.set(name,{schema,run:execute});
    server.registerTool(name,{description:descriptions[name],inputSchema:schema as z.ZodType,annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:{securitySchemes:[{type:"oauth2",scopes:["cloud:access"]}]}},async args=>respond(()=>run(args as z.output<S>)));
  }
  async function respond(action:()=>Promise<unknown>) {
    try {
      const data=await action();
      const result={content:[{type:"text" as const,text:"Completed."}],structuredContent:{ok:true,data:data as Record<string,unknown>}};
      if(new TextEncoder().encode(JSON.stringify(result)).length>1024*1024+4096) return failure("storage_unavailable");
      return result;
    } catch(e) { return failure(e instanceof RecordError && errorCodes.includes(e.code) ? e.code : "storage_unavailable"); }
  }
  add("get_business_context",z.strictObject({}),true,async()=>{const business=await records.getBusinessContext(authority); const parts=new Intl.DateTimeFormat("en-US",{timeZone:business.value.timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date((dependencies.now??Date.now)())); const get=(type:string)=>parts.find(p=>p.type===type)!.value; return {business,today:`${get("year")}-${get("month")}-${get("day")}`};});
  add("search_customers",search,true,args=>records.searchCustomers(authority,args));
  add("get_customer",id,true,args=>records.getCustomer(authority,args.id));
  add("create_customer",z.strictObject({operationKey:str,expectedRevision:z.literal(0),id:str.optional(),value:customer}),false,args=>records.createCustomer(authority,args));
  add("search_saved_rates",search,true,args=>records.searchSavedRates(authority,args));
  add("get_pricing_guidance",z.strictObject({query:str,unit,kind,limit:z.number().int().min(1).max(20)}),true,args=>pricing.getPricingGuidance(authority,args));
  add("preview_document",preview,true,args=>previews.previewDocument(authority,args));
  add("create_document",preview.extend({operationKey:str}),false,args=>docs.createDocument(authority,args));
  add("get_document",id,true,args=>docs.getDocument(authority,args.id));
  add("update_document",z.strictObject({operationKey:str,id:str,expectedRevision:rev,patch}),false,args=>docs.updateDocument(authority,args));
  add("convert_estimate_to_invoice",z.strictObject({operationKey:str,id:str,expectedRevision:rev,issueDate:str,dueDate:nullable}),false,args=>docs.convertEstimateToInvoice(authority,args));
  add("open_in_app",id,true,async args=>{const doc=await docs.getDocument(authority,args.id); return {id:doc.id,revision:doc.revision,url:`co.simplitica.simpli-invoice://cloud/document/${doc.id}?revision=${doc.revision}`,requiresNativeReview:true};});
  server.server.setRequestHandler("tools/call",async request=>{
    const entry=registry.get(request.params.name); if(!entry) return failure("invalid_input");
    const parsed=entry.schema.safeParse(request.params.arguments??{}); if(!parsed.success) return failure("invalid_input");
    return respond(()=>entry.run(parsed.data as never));
  });
  return server;
}
