/**
 * Set of AWS helper functions that facilitates the creation of a temporary SQS queue, to relay
 * the processing from one Lambda call to another.
 * 
 * (c) MacLaurin Group 2018
 *    https://github.com/MacLaurinGroup/awsLambdaRelay
 *    https://maclaurin.group/
 * 
 * 
 * Requires the following permission:
 *      - "sqs:*"
 *      - "lambda:CreateEventSourceMapping"
 *      - "lambda:DeleteEventSourceMapping"
 * 
 */
"use strict";


const AWS = require("aws-sdk");
const sqs = new AWS.SQS();
const lambda = new AWS.Lambda();


module.exports = {

  /**
   * Creates the temporary SQS queue and attaches it to the given Lambda function
   * 
   */
  setup: async function(context, lambdaFunctionName, queueName, attributes) {
    const awsRegion = JSON.stringify(context.invokedFunctionArn).split(":")[3];
    const awsAccId = JSON.stringify(context.invokedFunctionArn).split(":")[4];

    if (queueName == "undefined") {
      queueName = "awsRelayQueue_" + lambdaFunctionName + "_" + new Date().getTime();
    }

    const EventSourceArn = "arn:aws:sqs:" + awsRegion + ":" + awsAccId + ":" + queueName;
    const FunctionName = "arn:aws:lambda:" + awsRegion + ":" + awsAccId + ":function:" + lambdaFunctionName;

    const relayPkt = {
      stats: {
        sqsCount: 0
      }
    };

    attributes = typeof attributes  !== "object"  ?  {} : attributes;
    if ( typeof(attributes.DelaySeconds) == 'undefined'  ){
      attributes.DelaySeconds = 0;
    }

    // Create a new queue
    const sqsResult = await sqs.createQueue({
      QueueName: queueName,
      Attributes: attributes
    }).promise();

    relayPkt.QueueUrl = sqsResult.QueueUrl;

    // Assign the Lambda callback to the new queue
    const lambdaResult = await lambda.createEventSourceMapping({
      EventSourceArn: EventSourceArn,
      FunctionName: FunctionName,
      Enabled: true,
      BatchSize: 1
    }).promise();

    relayPkt.UUID = lambdaResult.UUID;

    console.log("setup(); " + JSON.stringify(relayPkt));

    return relayPkt;
  },



  /**
   * Returns the RelayPacket
   */
  getRelayPkt: function(event) {

    // Small test for the object type when we are invoking locally via serverless
    if (typeof event.Records[0].body == "object") {
      event.Records[0].body = JSON.stringify(event.Records[0].body);
    }
    const relayPkt = JSON.parse(event.Records[0].body);

    if (typeof relayPkt.QueueUrl == "undefined" || typeof relayPkt.UUID == "undefined" ) {
      console.log("[ERROR] Bad SQS message; " + JSON.stringify(relayPkt));
      return null;
    }

    if (typeof relayPkt.attempt == "undefined") {
      relayPkt.attempt = 0;
    }

    if (typeof relayPkt.stats == "undefined") {
      relayPkt.stats = {
        sqsCount: 0
      };
    }

    return relayPkt;
  },



  /**
   * Send out the message to the queue for the next relay
   */
  relayPass: async function(relayPkt, delaySeconds) {
    if (typeof relayPkt.QueueUrl == "undefined" || relayPkt.QueueUrl == "") {
      return false;
    }

    relayPkt.stats.sqsCount++;

    if (typeof delaySeconds == "undefined") {
      delaySeconds = 0;
    }

    // Make sure they are within our limits
    if ( delaySeconds > (15*60 )){
      delaySeconds = 15*60;
    } else if ( delaySeconds < 0 ){
      delaySeconds = 0;
    }

    const messageBody = JSON.stringify(relayPkt);

    await sqs.sendMessage({
      MessageBody: messageBody,
      QueueUrl: relayPkt.QueueUrl,
      DelaySeconds: delaySeconds
    }).promise();

    console.log("sendMessage(); " + messageBody);
    return true;
  },



  /**
   * Closes everything off again
   */
  tearDown: async function(relayPkt) {
    if (typeof relayPkt.QueueUrl == "undefined" || relayPkt.QueueUrl == "" || typeof relayPkt.UUID == "undefined" || relayPkt.UUID == "") {
      return false;
    }

    await lambda.deleteEventSourceMapping({
      UUID: relayPkt.UUID
    }).promise();

    await sqs.deleteQueue({
      QueueUrl: relayPkt.QueueUrl
    }).promise();

    console.log("tearDown(); " + relayPkt.QueueUrl);
    return true;
  }

};