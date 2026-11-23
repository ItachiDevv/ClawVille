import {encodeFunctionData, encodeAbiParameters, parseAbi, type Address} from 'viem';
import {CONFIGURED_AUTHORITY_GETTERS, readConfiguredAuthority} from '../configured-authority';
import type {ConfiguredAuthorityReader} from '../configured-authority-reader';

/** Controlled local RPC responses; exercises all fourteen getters and the final anchor read. */
export function fixtureConfiguredAuthorityReader(blockHash=`0x${'a'.repeat(64)}`, blockNumber=5000n):ConfiguredAuthorityReader {
  return async input => {
    const observedAt=new Date();
    const anchor={number:`0x${blockNumber.toString(16)}`,hash:blockHash,timestamp:`0x${Math.floor(observedAt.getTime()/1000).toString(16)}`};
    return readConfiguredAuthority(async (method,params) => {
      if(method==='eth_chainId')return '0x430c6';
      if(method==='eth_getBlockByNumber') {
        if(params[0]!==anchor.number||params[1]!==false)throw Error('Unexpected fixture anchor');
        return anchor;
      }
      if(method==='eth_call') {
        const call=params[0] as {to:string;data:string};
        if(params[1]!==anchor.number)throw Error('Unexpected fixture getter block');
        for(const [target,name,type,expected] of CONFIGURED_AUTHORITY_GETTERS){
          const abi=parseAbi([`function ${name}() view returns (${type})`]);
          if(call.to===target&&call.data===encodeFunctionData({abi,functionName:name!}))
            return type==='address'
              ? encodeAbiParameters([{type:'address'}],[expected as Address])
              : type==='uint32'
                ? encodeAbiParameters([{type:'uint32'}],[Number(expected)])
                : encodeAbiParameters([{type:'uint256'}],[BigInt(expected!)]);
        }
      }
      throw Error('Unexpected configured authority fixture RPC');
    },anchor,observedAt,input.observationPolicy,{deadlineMs:input.deadlineMs,signal:input.signal});
  };
}
