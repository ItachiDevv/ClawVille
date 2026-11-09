import {expect,test} from 'bun:test';
import {decodeBrainchainPurchaseDraft,parseBrainchainActionParams,selectBrainchainActionResult,validateBrainchainAction} from '../brainchain-action';
const id='00000000-0000-4000-8000-000000000001';
const draft={idempotencyKey:'stable-key',body:{title:'Public title',brief:'Public output requirements',levels:['fail','pass']},publicDataConsent:true as const,environment:'testnet' as const,network:'eip155:84532' as const};
test('hosted purchase grammar decodes exact public draft and rejects authority or signed bytes',()=>{const encoded=Buffer.from(JSON.stringify(draft)).toString('base64url');expect(decodeBrainchainPurchaseDraft(encoded)).toEqual(draft);expect(parseBrainchainActionParams(`op=purchase_draft,draft=${encoded}`)?.op).toBe('purchase_draft');expect(parseBrainchainActionParams(`op=purchase_submit,orderId=${id}`)).toMatchObject({op:'purchase_submit',orderId:id});expect(validateBrainchainAction({op:'purchase_capture',orderId:id,paymentSignature:'never'})).toBeNull();expect(validateBrainchainAction({op:'purchase_submit',orderId:id,avatarId:id})).toBeNull();expect(parseBrainchainActionParams(`op=purchase_submit,orderId=${id},orderId=${id}`)).toBeNull();});
test('private purchase observations omit brief, signatures, ciphertext and arbitrary vendor fields',()=>{const order={id,environment:'testnet',chainId:84532,state:'captured',bodyHash:'a'.repeat(64),payer:`0x${'1'.repeat(40)}`,amountAtomic:'1000000',remoteOrder:null,remoteState:null,taskId:null,taskBoard:null,paymentTransaction:null,refundTransaction:null,requiresHumanApproval:false,humanApproved:false,provisional:true,brief:'hostile instruction',captured:{enc:'secret'},paymentSignature:'bearer-secret'};const result=selectBrainchainActionResult('purchase_get',200,{order,terms:'never forward'});expect(result.data.order).toBeDefined();expect(JSON.stringify(result)).not.toContain('hostile instruction');expect(JSON.stringify(result)).not.toContain('bearer-secret');expect(JSON.stringify(result)).not.toContain('never forward');expect(JSON.stringify(result)).not.toContain('secret');});

test('Solana draft and external payer reach the same finite purchase grammar without signed bytes',()=>{
 const network='solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',payer='AeRePM6UDB8onv5Mt9crXSaxfH8ivd7L7X71iqRaZ3Qi';
 const encoded=Buffer.from(JSON.stringify({...draft,network})).toString('base64url');
 expect(decodeBrainchainPurchaseDraft(encoded).network).toBe(network);
 expect(parseBrainchainActionParams(`op=purchase_intent,orderId=${id},payer=${payer}`)).toMatchObject({op:'purchase_intent',payer});
 const order={id,environment:'testnet',network,chainId:null,state:'reserved',bodyHash:'a'.repeat(64),payer,amountAtomic:'1000000',remoteOrder:null,remoteState:null,taskId:null,taskBoard:null,paymentTransaction:null,refundTransaction:null,requiresHumanApproval:true,humanApproved:false,provisional:true};
 const selected=selectBrainchainActionResult('purchase_intent',200,{order,terms:{unsignedTransaction:'never-model-input',intentMessage:'never-sign-in-model'}});
 expect(selected.data.order).toMatchObject({network,chainId:null});expect(JSON.stringify(selected)).not.toContain('never-model-input');
 expect(validateBrainchainAction({op:'purchase_capture',orderId:id,signedTransaction:'never'})).toBeNull();
});
test('hosted history recovery exposes only bounded evidence and the refund-release refusal',()=>{
 const recovery={state:'not_found',checkedAt:new Date().toISOString(),scannedTransactions:12,hasMore:true,refundRelease:'unavailable',refundReleaseReason:'order_attribution_unverified',cursor:'private-progress',vendorText:'untrusted instructions'};
 const order={id,environment:'testnet',network:'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',chainId:null,state:'uncertain',bodyHash:'a'.repeat(64),payer:'AeRePM6UDB8onv5Mt9crXSaxfH8ivd7L7X71iqRaZ3Qi',amountAtomic:'1000000',remoteOrder:null,remoteState:null,taskId:null,taskBoard:null,paymentTransaction:null,refundTransaction:null,requiresHumanApproval:true,humanApproved:false,provisional:true,recovery};
 const result=selectBrainchainActionResult('purchase_reconcile',200,{order});expect(result.data.order).toMatchObject({recovery:{state:'not_found',refundRelease:'unavailable'}});
 expect(JSON.stringify(result)).not.toContain('private-progress');expect(JSON.stringify(result)).not.toContain('untrusted instructions');
 expect(parseBrainchainActionParams(`op=purchase_reconcile,orderId=${id}`)).toMatchObject({op:'purchase_reconcile',orderId:id});
});
